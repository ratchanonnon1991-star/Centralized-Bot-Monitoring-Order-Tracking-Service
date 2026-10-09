/** Integration tests: need PostgreSQL from `docker compose up -d postgres`. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '\.e2e-spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 30000,
};
