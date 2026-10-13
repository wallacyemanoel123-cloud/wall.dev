// Gera o valor do segredo OWNER_PASSWORD_HASH (PBKDF2-SHA256, 100 000 iterações).
// Uso: npm run hash-password   (a senha é pedida no terminal e não fica no histórico)
import { createInterface } from 'node:readline';
import { hashPassword } from '../server/auth.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));
const fromArg = process.env.WALL_PASSWORD;
const pass = fromArg ?? await ask('Nova senha (mínimo 12 caracteres): ');
rl.close();
if (pass.length < 12) { console.error('Senha muito curta. Use pelo menos 12 caracteres.'); process.exit(1); }
console.log('\nOWNER_PASSWORD_HASH=' + await hashPassword(pass));
console.log('\nGuarde a senha num gerenciador de senhas. O valor acima vai SOMENTE para os segredos da Cloudflare.');
