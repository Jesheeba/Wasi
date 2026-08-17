require('dotenv').config();
const { createApp } = require('./app');
const broadcastRunner = require('./services/broadcastRunner');

const port = process.env.PORT || 4000;
const app = createApp();

app.listen(port, () => {
  console.log(`wasi-crm-server listening on http://localhost:${port}`);
  broadcastRunner.start();
});
