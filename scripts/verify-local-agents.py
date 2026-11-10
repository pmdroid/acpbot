"""Exercise ACP initialization, session creation, and a harmless real prompt."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

agent = sys.argv[1]
command = {
    "mimo": ["/home/spooky/.local/bin/mimo", "acp"],
    "codex": ["/home/spooky/.nvm/versions/node/v24.22.2/bin/node",
              "/home/spooky/.local/share/acpbot/runtime/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
}[agent]
events = queue.Queue()
text_parts = []
notify_tool_ids = set()
env = dict(os.environ, CODEX_PATH="/home/spooky/.local/bin/codex")
with tempfile.TemporaryDirectory(prefix="telegram-acp-check-") as cwd:
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    def reader():
        for line in process.stdout:
            try:
                events.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    threading.Thread(target=reader, daemon=True).start()
    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()
    def rpc(number, method, params, timeout=90):
        send({"jsonrpc": "2.0", "id": number, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = events.get(timeout=min(1, max(.01, deadline-time.monotonic())))
            except queue.Empty:
                if process.poll() is not None:
                    raise RuntimeError("Agent exited before responding")
                continue
            update = message.get("params", {}).get("update", {})
            if update.get("sessionUpdate") == "agent_message_chunk":
                text_parts.append(update.get("content", {}).get("text", ""))
            if update.get("sessionUpdate") == "tool_call" and any(name in str(update.get('title','')) for name in ['telegram_connect','telegram_notify']):
                notify_tool_ids.add(update.get('toolCallId'))
            if "method" in message and "id" in message:
                if message["method"] == "session/request_permission":
                    params = message.get('params',{})
                    allowed = '--notify-check' in sys.argv and (params.get('toolCall',{}).get('toolCallId') in notify_tool_ids or 'telegram_notify' in json.dumps(params.get('toolCall',{})))
                    option = next((o for o in params.get('options',[]) if o.get('kind') == 'allow_once'), None) if allowed else None
                    outcome = {'outcome':'selected','optionId':option['optionId']} if option else {'outcome':'cancelled'}
                    send({"jsonrpc":"2.0", "id":message["id"], "result":{"outcome":outcome}})
                else:
                    send({"jsonrpc":"2.0", "id":message["id"], "error":{"code":-32601,"message":"Unsupported check client request"}})
            if message.get("id") == number and "method" not in message:
                if "error" in message:
                    raise RuntimeError(json.dumps(message["error"]))
                return message.get("result", {})
        raise TimeoutError(method)
    try:
        init = rpc(1, "initialize", {"protocolVersion":1,"clientInfo":{"name":"telegram-bridge-check","version":"1"},"clientCapabilities":{}})
        print(agent, "initialized", init.get("agentInfo", {}), flush=True)
        session = rpc(2, "session/new", {"cwd":cwd, "mcpServers":[]})
        sid = session["sessionId"]
        print(agent, "session created", flush=True)
        prompt = "Reply exactly BRIDGE_OK. Do not use tools or change files."
        if "--notify-check" in sys.argv:
            prompt = (f"Use the telegram_notify MCP server tools. First call telegram_connect with agent='{agent}', "
                      f"session_id='native-{agent}-mcp-verification', name='Native MCP check', repo_root='/data/projects/playground'. "
                      f"Then call telegram_notify using the returned binding_id and text='{agent.upper()}_SELECTIVE_MCP_OK'. "
                      "Use only those tools and necessary MCP discovery. Do not use shell or change files. "
                      "Reply exactly BRIDGE_OK only after both tools succeeded; otherwise explain the actual error.")
        result = rpc(3, "session/prompt", {"sessionId":sid,"prompt":[{"type":"text","text":prompt}]}, timeout=120)
        print(agent, "prompt result", result.get("stopReason"), "text:", "".join(text_parts), flush=True)
        if "BRIDGE_OK" not in "".join(text_parts):
            raise RuntimeError("Expected response not received at completion")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
