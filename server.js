// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Configure CORS
app.use(
  cors({
    origin: "http://localhost:3006",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json());

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3006",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const REPOS_DIR = path.join(__dirname, "repos");
const activeProcesses = new Map();

// Ensure repos directory exists
if (!fs.existsSync(REPOS_DIR)) {
  fs.mkdirSync(REPOS_DIR);
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// Process output handling function
const processOutput = (buffer, data, type, commandId) => {
  buffer += data;
  const lines = buffer.split("\r");
  const lastLine = lines.pop();

  // Process complete lines
  lines.forEach((line) => {
    if (line.trim()) {
      io.emit("commandOutput", {
        commandId,
        output: line,
        outputType: type,
        isProgress:
          line.includes("░") ||
          line.includes("█") ||
          line.includes("%") ||
          line.includes("...") ||
          /\[\d+\/\d+\]/.test(line),
      });
    }
  });

  // Handle progress line updates
  if (lastLine.trim()) {
    io.emit("commandOutput", {
      commandId,
      output: lastLine,
      outputType: type,
      isProgress: true,
      replaceLast: true,
    });
  }

  return lastLine;
};

async function executeCommand(command, cwd, commandId, description) {
  console.log(command);
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    // Emit the description before starting the command
    if (description) {
      io.emit("commandOutput", {
        commandId,
        output: `${description}\n`,
        outputType: "system",
      });
    }

    const childProcess = spawn(command, [], {
      cwd,
      shell: true,
      env: {
        ...process.env,
        FORCE_COLOR: true,
        NPM_CONFIG_COLOR: "always",
      },
    });

    activeProcesses.set(commandId, childProcess);

    childProcess.stdout.on("data", (data) => {
      stdoutBuffer = processOutput(
        stdoutBuffer,
        data.toString(),
        "stdout",
        commandId
      );
    });

    childProcess.stderr.on("data", (data) => {
      stderrBuffer = processOutput(
        stderrBuffer,
        data.toString(),
        "stderr",
        commandId
      );
    });

    childProcess.on("close", (code) => {
      // Emit any remaining buffered output
      if (stdoutBuffer.trim()) {
        io.emit("commandOutput", {
          commandId,
          output: stdoutBuffer + "\n",
          outputType: "stdout",
        });
      }
      if (stderrBuffer.trim()) {
        io.emit("commandOutput", {
          commandId,
          output: stderrBuffer + "\n",
          outputType: "stderr",
        });
      }

      io.emit("commandOutput", {
        commandId,
        output: `Process finished with exit code: ${code}\n`,
        outputType: code === 0 ? "success" : "error",
      });

      activeProcesses.delete(commandId);

      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    childProcess.on("error", (error) => {
      reject(error);
    });
  });
}

app.post("/api/deploy", async (req, res) => {
  const { gitUrl, branch } = req.body;
  const commandId = Date.now().toString();
  let repoPath;

  try {
    const repoName = gitUrl.split("/").pop().replace(".git", "");
    repoPath = path.join(REPOS_DIR, repoName);

    io.emit("commandOutput", {
      commandId,
      output: `Starting deployment process for ${repoName}...\n`,
      outputType: "system",
    });

    // Sequential execution of commands
    if (!fs.existsSync(repoPath)) {
      await executeCommand(
        `git clone ${gitUrl}`,
        REPOS_DIR,
        commandId,
        `Cloning repository ${gitUrl}...`
      );
    } else {
      await executeCommand(
        "git fetch --all",
        repoPath,
        commandId,
        "Repository exists, fetching latest changes..."
      );
    }

    await executeCommand(
      `git checkout ${branch} && git pull origin ${branch}`,
      repoPath,
      commandId,
      `Checking out branch: ${branch}`
    );

    await executeCommand(
      "npm install",
      repoPath,
      commandId,
      "Installing dependencies..."
    );

    await executeCommand(
      "npm run build",
      repoPath,
      commandId,
      "Building the application..."
    );

    io.emit("commandFinished", {
      commandId,
      exitCode: 0,
    });

    res.json({ success: true, commandId });
  } catch (error) {
    io.emit("commandOutput", {
      commandId,
      output: `Error: ${error.message}\n`,
      outputType: "stderr",
    });

    io.emit("commandFinished", {
      commandId,
      exitCode: 1,
    });

    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/stop", (req, res) => {
  const { commandId } = req.body;
  const processToStop = activeProcesses.get(commandId);

  if (processToStop) {
    processToStop.kill();
    activeProcesses.delete(commandId);
    io.emit("commandOutput", {
      commandId,
      output: "Process stopped by user\n",
      outputType: "system",
    });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: "Process not found" });
  }
});

app.get("/api/repos", (req, res) => {
  try {
    const repos = fs
      .readdirSync(REPOS_DIR)
      .filter((file) => fs.statSync(path.join(REPOS_DIR, file)).isDirectory());
    res.json({ repos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clean up on server shutdown
process.on("SIGTERM", () => {
  activeProcesses.forEach((proc) => {
    proc.kill();
  });
  activeProcesses.clear();
  process.exit(0);
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
