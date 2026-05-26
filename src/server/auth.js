export function getBearerToken(request) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  if (request.query?.token) return request.query.token;
  return '';
}

export function requireAdmin(config) {
  return async function adminAuth(request, reply) {
    if (getBearerToken(request) !== config.appToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export function requireAgentToken(config, request) {
  return request.query?.token === config.agentToken;
}
