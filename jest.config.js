/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Aísla cada test en su propio cwd temporal para que "data/..." no toque el data real.
  setupFiles: ['<rootDir>/test/_setup.ts'],
};
