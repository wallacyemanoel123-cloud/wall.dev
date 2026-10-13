// Cloudflare Pages Function: encaminha /api/* para o roteador.
import { handle } from '../../server/app.js';

export const onRequest = ({ request, env }) => handle(request, env);
