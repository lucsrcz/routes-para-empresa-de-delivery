# Planejamento: Expansão Logística (Admin vs Motoristas)

Este documento contém a arquitetura para evoluir o **Routes Prodesivo** de um aplicativo individual para uma plataforma completa de gerenciamento de frotas e motoristas.

## 🎯 Objetivo Central
Um usuário terá o sistema de **Administrador**. Ele conseguirá montar rotas normalmente pela ferramenta "Builder" e, ao gerar a rota, enviar diretamente para o celular/conta do **Motorista** desejado em tempo real.

---

## 🗺️ Passo a Passo da Execução

### Passo 1: Hierarquia de Papéis (Roles)
Precisamos ensinar o Firebase a diferenciar quem é "Chefe" e quem é "Peão".
1. Criar um documento na raiz do banco de dados (Firestore) na Coleção `users`.
2. Para o seu próprio UID (seu e-mail centralização), criaremos o campo: `role: "admin"`.
3. Todos os novos usuários que criarem conta serão marcados por padrão no código como `role: "driver"`.
4. **Lógica no `app.js`:** Ao realizar o Login (`onAuthStateChanged`), o app fará um fetch no documento do usuário:
   - *Se for Admin:* Libera o painel de geração de rotas.
   - *Se for Driver:* Esconde ou desabilita o painel de "Meus Locais" / "Gerar Rota". Foca apenas na tela de exibição das missões recebidas.

### Passo 2: Dropdown de "Despacho" (Interface do Admin)
Para o administrador enviar a rota para a pessoa correta:
1. No painel modal "Configurar Rota Manual", ao lado do botão "Mapa/Salvar", adicionaremos um *Select (Dropdown)* que irá buscar e listar todos os usuários cuja role seja `"driver"`


ja fiz as de cima 




.
2. **Exemplo UI:** `<select id="adminDriverSelect"> <option value="UID_DO_MATEUS">Mateus</option> </select>`

### Passo 3: O "Disparo" em Tempo Real (Core da Ideia)
A função `generateManualRoute()` será reformulada:
* **Hoje é assim:** Salva no perfil de quem está logado. \
  `addDoc(collection(db, "users", currentUser.uid, "history"), data)`
* **Amanhã será assim:** Salva no perfil do funcionário selecionado no select. \
  `addDoc(collection(db, "users", driverSelect.value, "history"), data)`
* *Magia do Firebase:* Assim que você adicionar no banco com o UID do motorista, o *"onSnapshot"* (ouvidor em tempo real) que roda no celular dele será acionado, atualizando o Card dele na hora.

### Passo 4: Retorno de Status (Visão do Admin)
Isso é o que dará o controle profissional a plataforma:
1. Na criação da rota, adicionar um status simples: `status: "Pendente"`.
2. No celular do Motorista, ao clicar em *"Iniciar Navegação"*, o sistema dele envia um update discreto pro banco de dados: `updateDoc(...) -> status: "Em Viagem"`.
3. No painel do Administrador, haverá uma interface pequena listando "Status da Frota" olhando e reagindo caso as rotas fiquem amarelas (Viagem) e verdes (Concluída).

---

## 🛠️ O Que Deverá Ser Codificado (Checklist Futuro para a IA)
Quando decidir startar, mande para a IA a seguinte instrução:

> *"Podemos começar o 'Passo 1' e 'Passo 2' do documento de ideia administrativa. Adicione um dropdown na tela de envio de rota e a checagem no `app.js` para diferenciar Admin e Driver."*

Arquivos que serão bastante envolvidos:
- `app.js`: Para lógica Firestore, Snapshot e lógica de roles.
- `routes_app_v3_responsive (1).html`: Para o modal/display de seleção de usuário.
- Controle Base do Firestore (gerenciar regras de privilégios de db para que usuários não editem rotas aleatórias).
