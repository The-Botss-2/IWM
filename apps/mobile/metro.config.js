// Metro config tuned for the pnpm monorepo: watch the workspace root so shared
// packages resolve, and look up modules in both the app and root node_modules.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm uses a non-hoisted store; disable hierarchical lookup so Metro resolves
// the symlinked packages deterministically.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
