import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import CONFIG from "./config.js";

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);
const db = getFirestore(app);

// Admin role can only be assigned manually via Firebase Console.

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Se tem convite na URL e o user já está logado, processar o vínculo antes de redirecionar
    const urlParams = new URLSearchParams(window.location.search);
    const convite = urlParams.get('convite');
    if (convite) {
      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        const inviteRef = doc(db, "invites", convite);
        const inviteSnap = await getDoc(inviteRef);
        
        if (inviteSnap.exists() && !inviteSnap.data().usado) {
          const inviteData = inviteSnap.data();
          
          if (userSnap.exists()) {
            // Usuário já tem conta — vincular diretamente
            await updateDoc(userRef, {
              role: 'driver',
              adminId: inviteData.adminId
            });
          } else {
            // Usuário novo (via Google) — criar doc
            await setDoc(userRef, {
              role: 'driver',
              adminId: inviteData.adminId,
              nome: user.displayName || '',
              email: user.email,
              createdAt: serverTimestamp()
            });
          }
          await updateDoc(inviteRef, { usado: true });
        }
      } catch(e) {
        console.warn('Erro ao processar convite para user logado:', e);
      }
    }
    window.location.href = "app.html";
  }
});

let isRegisterMode = false;
let selectedRole = null; // 'admin' ou 'driver'

// ── Seleção de Role ──
window.selectRole = function(role) {
  selectedRole = role;
};

window.toggleMode = function(mode) {
  const lbl = document.getElementById('formLabel');
  const title = document.getElementById('formTitle');
  const sub = document.getElementById('formSub');
  const btn = document.getElementById('btn-text');
  const footer = document.getElementById('formFooter');
  const extras = document.getElementById('fieldExtras');
  const roleArea = document.getElementById('roleSelectionArea');
  const nomeField = document.getElementById('fieldNome');

  if(mode === 'register') {
    isRegisterMode = true;
    lbl.textContent = 'Novo acesso';
    title.textContent = 'Criar Conta';
    sub.textContent = 'Preencha seus dados básicos';
    btn.textContent = 'Cadastrar';
    extras.style.display = 'none';
    nomeField.style.display = 'block';
    
    footer.innerHTML = `Já possui conta? <a onclick="toggleMode('login')" style="cursor:pointer; color:#1A6BAF; font-weight:bold;">Fazer login</a>`;
  } else {
    isRegisterMode = false;
    lbl.textContent = 'Acesso à plataforma';
    title.textContent = 'Entrar na conta';
    sub.textContent = 'Use suas credenciais para acessar';
    btn.textContent = 'Entrar';
    extras.style.display = 'flex';
    nomeField.style.display = 'none';
    footer.innerHTML = `Não tem conta? <a onclick="toggleMode('register')" style="cursor:pointer; color:#1A6BAF; font-weight:bold;">Criar conta agora</a>`;
  }

  // Check URL for invite code
  checkUrlInviteCode();
};

// ── Verifica código de convite na URL ──
function checkUrlInviteCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const convite = urlParams.get('convite');
  if (convite && isRegisterMode) {
    selectedRole = 'driver';
    window.selectRole('driver');
    document.getElementById('inviteCodeInput').value = convite;
  }
}

// On page load, check for invite code
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('convite')) {
    // Auto-switch to register mode
    setTimeout(() => {
      window.toggleMode('register');
    }, 300);
  }
})();

function showToast(message, type = 'error') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '✅' : '⚠';
  
  toast.innerHTML = `
    <span>${icon}</span>
    <div class="toast-msg">${message}</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

window.handleForgotPassword = async function() {
  const email = document.getElementById('emailinput').value.trim();
  if (!email) {
    showToast("Digite seu e-mail no campo acima para recuperar a senha.");
    document.getElementById('emailinput').focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    showToast("E-mail de recuperação enviado! Verifique sua caixa de entrada.", "success");
  } catch (error) {
    let msg = "Erro ao enviar e-mail de recuperação.";
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-email') {
      msg = "E-mail não encontrado ou inválido.";
    } else if (error.code === 'auth/too-many-requests') {
      msg = "Muitas tentativas. Aguarde alguns minutos.";
    }
    showToast(msg);
  }
};

window.handleAuth = async function(btn) {
  const t = document.getElementById('btn-text');
  const email = document.getElementById('emailinput').value.trim();
  const password = document.getElementById('pwdinput').value;
  const nome = document.getElementById('nomeinput').value.trim();

  if (!email || !password) {
    showToast("Por favor, preencha o e-mail e a senha.");
    return;
  }

  // ═══ VALIDAÇÕES DE CADASTRO ═══
  if (isRegisterMode) {
    if (!nome) {
      showToast("Por favor, digite seu nome.");
      return;
    }
  }

  t.textContent = 'Aguarde...';
  btn.style.opacity = '.75';
  btn.style.pointerEvents = 'none';

  // Checkbox "Lembrar-me" — controla a persistência da sessão
  const rememberMe = document.querySelector('.check-box')?.classList.contains('checked');
  try {
    await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  } catch(e) { console.warn('Erro ao definir persistência:', e); }

  try {
    if (isRegisterMode) {
      // 1) Criar conta no Firebase Auth
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const uid = userCredential.user.uid;

      // Se tiver um convite no URL passamos junto pra quando logar, mas salvaremos ele como pending local
      const inviteCode = document.getElementById('inviteCodeInput').value.trim();

      // 2) Salvar no Firestore
      await setDoc(doc(db, "users", uid), {
        role: 'pending',
        nome: nome,
        email: email,
        inviteCodeCache: inviteCode || null,
        createdAt: serverTimestamp()
      });

      showToast("Conta criada com sucesso! Redirecionando...", "success");
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (error) {
    let msg = "Erro desconhecido";
    if (error.code === 'auth/email-already-in-use') {
      msg = "Este e-mail já está cadastrado. Tente fazer login.";
    } else if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
      msg = "E-mail ou senha incorretos.";
    } else if (error.code === 'auth/weak-password') {
      msg = "A senha deve ter pelo menos 6 caracteres.";
    } else if (error.code === 'auth/invalid-email') {
      msg = "Formato de e-mail inválido.";
    } else {
      msg = "Erro: " + error.code;
    }
    showToast(msg);
    t.textContent = isRegisterMode ? 'Cadastrar' : 'Entrar';
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  }
};

const provider = new GoogleAuthProvider();

window.handleGoogleLogin = async function(btn) {
  btn.style.opacity = '.75';
  btn.style.pointerEvents = 'none';
  const originalContent = btn.innerHTML;
  btn.innerHTML = 'Conectando...';

  // Aplicar persistência do "Lembrar-me" também no Google Login
  const rememberMe = document.querySelector('.check-box')?.classList.contains('checked');
  try {
    await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  } catch(e) { console.warn('Erro ao definir persistência (Google):', e); }

  try {
    const result = await signInWithPopup(auth, provider);
    
    // Check if user document exists — if not (first time Google login), prompt for role
    const uid = result.user.uid;
    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      // For Google sign-in, by default assign driver if no role selection visible
        // If register mode was active and a role was selected, use that
      if (isRegisterMode && selectedRole) {
        const nome = document.getElementById('nomeinput').value.trim() || result.user.displayName || '';

        if (selectedRole === 'driver') {
          const inviteCode = document.getElementById('inviteCodeInput').value.trim();
          if (inviteCode) {
            const inviteRef = doc(db, "invites", inviteCode);
            const inviteSnap = await getDoc(inviteRef);
            if (inviteSnap.exists() && !inviteSnap.data().usado) {
              await setDoc(userRef, { role: 'driver', nome: nome, email: result.user.email, adminId: inviteSnap.data().adminId, createdAt: serverTimestamp() });
              await updateDoc(inviteRef, { usado: true });
            } else {
              await setDoc(userRef, { role: 'driver', nome: nome, email: result.user.email, createdAt: serverTimestamp() });
            }
          } else {
            await setDoc(userRef, { role: 'driver', nome: nome, email: result.user.email, createdAt: serverTimestamp() });
          }
        }
      } else {
        // Default: create as pending (login mode via Google, first time — role picker will show in app)
        await setDoc(userRef, { role: 'pending', nome: result.user.displayName || '', email: result.user.email, createdAt: serverTimestamp() });
      }
    }
    // Redirect happens via onAuthStateChanged
  } catch (error) {
    let msg = "Erro no Google Login";
    if (error.code === 'auth/popup-closed-by-user') {
      msg = "A janela de login foi fechada antes de concluir.";
    } else if (error.code === 'auth/operation-not-allowed') {
      msg = "O login com Google não está ativado no Firebase Console.";
    } else if (error.code === 'auth/unauthorized-domain') {
      msg = "Este domínio não está autorizado no Firebase.";
    } else if (error.code === 'auth/popup-blocked') {
      msg = "O navegador bloqueou a janela de login. Verifique os pop-ups.";
    } else {
      msg = "Erro: " + error.code;
    }
    showToast(msg);
    btn.innerHTML = originalContent;
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  }
};

window.toggleTheme = function() {
  var p = document.getElementById('page');
  var l = document.getElementById('tlabel');
  p.classList.toggle('dm');
  const isDark = p.classList.contains('dm');
  l.textContent = isDark ? '☾ Escuro' : '☀ Claro';
  localStorage.setItem('routes-theme', isDark ? 'dark' : 'light');
};

// Carregar tema salvo ao abrir a página
(function() {
  const saved = localStorage.getItem('routes-theme');
  if (saved === 'dark') {
    document.getElementById('page').classList.add('dm');
    document.getElementById('tlabel').textContent = '☾ Escuro';
  }
})();

window.togglePwd = function() {
  var i = document.getElementById('pwdinput');
  var e = document.getElementById('eyeicon');
  if(i.type === 'password'){ i.type = 'text'; e.textContent = '🙈'; }
  else { i.type = 'password'; e.textContent = '👁'; }
};

window.toggleCheck = function(el) {
  el.querySelector('.check-box').classList.toggle('checked');
};
