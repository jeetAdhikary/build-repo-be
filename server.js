// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const app = express();
const server = http.createServer(app);

// Configure CORS
app.use(cors({
  origin: "http://localhost:3006",
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3006",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const REPOS_DIR = path.join(__dirname, 'repos');
const activeProcesses = new Map();

// Ensure repos directory exists
if (!fs.existsSync(REPOS_DIR)) {
  fs.mkdirSync(REPOS_DIR);
}

async function executeCommand(command, cwd, commandId) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, [], {
      cwd,
      shell: true
    });

    process.stdout.on('data', (data) => {
      io.emit('commandOutput', {
        commandId,
        output: data.toString(),
        type: 'stdout'
      });
    });

    process.stderr.on('data', (data) => {
      io.emit('commandOutput', {
        commandId,
        output: data.toString(),
        type: 'stderr'
      });
    });

    process.on('close', (code) => {
      io.emit('commandFinished', {
        commandId,
        exitCode: code
      });
      resolve(code);
    });

    process.on('error', (error) => {
      reject(error);
    });

    activeProcesses.set(commandId, process);
  });
}

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

app.post('/api/deploy', async (req, res) => {
  const { gitUrl, branch } = req.body;
  const commandId = Date.now().toString();

  try {
    const repoName = gitUrl.split('/').pop().replace('.git', '');
    const repoPath = path.join(REPOS_DIR, repoName);

    io.emit('commandOutput', {
      commandId,
      output: `Starting deployment process for ${repoName}...\n`,
      type: 'system'
    });

    if (!fs.existsSync(repoPath)) {
      io.emit('commandOutput', {
        commandId,
        output: `Cloning repository ${gitUrl}...\n`,
        type: 'system'
      });
      await executeCommand(`git clone ${gitUrl}`, REPOS_DIR, commandId);
    } else {
      io.emit('commandOutput', {
        commandId,
        output: `Repository exists, fetching latest changes...\n`,
        type: 'system'
      });
      await executeCommand('git fetch --all', repoPath, commandId);
    }

    io.emit('commandOutput', {
      commandId,
      output: `Checking out branch: ${branch}\n`,
      type: 'system'
    });
    await executeCommand(`git checkout ${branch} && git pull origin ${branch}`, repoPath, commandId);

    io.emit('commandOutput', {
      commandId,
      output: 'Installing dependencies...\n',
      type: 'system'
    });
    await executeCommand('npm install', repoPath, commandId);

    io.emit('commandOutput', {
      commandId,
      output: 'Building the application...\n',
      type: 'system'
    });
    await executeCommand('npm run build', repoPath, commandId);

    res.json({ success: true, commandId });
  } catch (error) {
    io.emit('commandOutput', {
      commandId,
      output: `Error: ${error.message}\n`,
      type: 'stderr'
    });

    io.emit('commandFinished', {
      commandId,
      exitCode: 1
    });

    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  const { commandId } = req.body;
  const process = activeProcesses.get(commandId);
  
  if (process) {
    process.kill();
    activeProcesses.delete(commandId);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Process not found' });
  }
});

app.get('/api/repos', (req, res) => {
  try {
    const repos = fs.readdirSync(REPOS_DIR)
      .filter(file => fs.statSync(path.join(REPOS_DIR, file)).isDirectory());
    res.json({ repos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});