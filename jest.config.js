/** Unit tests: pure logic, no database needed. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  testRegex: '\.spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
};
