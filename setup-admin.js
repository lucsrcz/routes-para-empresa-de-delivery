/**
 * ═══════════════════════════════════════════════════════════
 * SETUP ADMIN — Script de uso único para gerar chave de admin
 * ═══════════════════════════════════════════════════════════
 * 
 * Execute: node setup-admin.js
 * 
 * Este script vai:
 * 1. Gerar uma chave secreta única (ADM-XXXXXX)
 * 2. Salvá-la temporariamente no Firestore
 * 3. Exibir a chave no terminal para você copiar
 * 
 * Após usar a chave no app, ela será DELETADA 
 * automaticamente do Firestore. Sem rastros.
 */

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Inicializa com Application Default Credentials (usa o login do Firebase CLI)
const app = initializeApp({
  projectId: 'rotas-cabun-app'
});

const db = getFirestore(app);

async function generateAdminKey() {
  const code = 'ADM-' + 
    Math.random().toString(36).substring(2, 5).toUpperCase() + 
    Math.random().toString(36).substring(2, 5).toUpperCase();

  try {
    await db.collection('admin_keys').doc(code).set({
      usado: false,
      createdBy: 'SYSTEM_SETUP',
      createdAt: new Date(),
      selfDestruct: true   // Marca que esta chave deve ser deletada após uso
    });

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ CHAVE DE ADMINISTRADOR GERADA!');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log(`  🔑  ${code}`);
    console.log('');
    console.log('  📋 Copie esta chave e use na tela de');
    console.log('     seleção de perfil do app.');
    console.log('');
    console.log('  ⚠️  Após o uso, esta chave será');
    console.log('     APAGADA automaticamente do banco.');
    console.log('═══════════════════════════════════════════');
    console.log('');

  } catch(err) {
    console.error('❌ Erro ao gerar chave:', err.message);
    console.log('');
    console.log('Dica: Verifique se você está logado no Firebase CLI:');
    console.log('  firebase login');
  }

  process.exit(0);
}

generateAdminKey();
