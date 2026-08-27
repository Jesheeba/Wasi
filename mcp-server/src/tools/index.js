const { tools: messagingTools } = require('./messaging');
const { tools: readTools } = require('./read');

const allTools = [...messagingTools, ...readTools];

function registerAllTools(server) {
  for (const { name, config, handler } of allTools) {
    server.registerTool(name, config, handler);
  }
}

module.exports = { allTools, registerAllTools };
