import { createStatelessApp } from './stateless.js';
import express from 'express';
import { resolve } from 'node:path';
const app = createStatelessApp();
app.use(express.static(resolve('dist')));
const port = Number(process.env.PORT || 3000);
app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Internscope browser workspace: http://localhost:${port}`));
