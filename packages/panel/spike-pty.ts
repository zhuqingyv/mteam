/**
 * Spike: validate node-pty works in this environment
 * Tests: spawn bash, write echo hello, capture output, kill
 */
import * as pty from "node-pty";

async function main() {
  console.log("Spawning PTY bash...");

  const ptyProcess = pty.spawn("bash", [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env as Record<string, string>,
  });

  let output = "";
  let resolved = false;

  const result = await new Promise<{ success: boolean; output: string }>(
    (resolve) => {
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ptyProcess.kill();
          resolve({ success: false, output: `TIMEOUT. Captured: ${output}` });
        }
      }, 5000);

      ptyProcess.onData((data) => {
        output += data;
        // Check for "hello" in output
        if (output.includes("hello") && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          ptyProcess.kill();
          resolve({ success: true, output });
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: output.includes("hello"),
            output: `Exit ${exitCode}. Captured: ${output}`,
          });
        }
      });

      // Give bash a moment to start, then send the echo command
      setTimeout(() => {
        ptyProcess.write("echo hello\r");
      }, 500);
    }
  );

  if (result.success) {
    console.log("SUCCESS: captured 'hello' in PTY output");
    console.log("Output sample:", JSON.stringify(output.slice(0, 200)));
    process.exit(0);
  } else {
    console.error("FAILED:", result.output);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
