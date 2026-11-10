"""Real stdio MCP + Telegram check. Sends only explicit diagnostic messages."""
import json, pathlib, queue, subprocess, sys, threading, time

process = subprocess.Popen(['/home/spooky/.local/bin/telegram-notify-mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
events = queue.Queue()
def reader():
    for line in process.stdout:
        try: events.put(json.loads(line))
        except json.JSONDecodeError: pass
threading.Thread(target=reader, daemon=True).start()
counter = 0
def rpc(method, params, timeout=65):
    global counter
    counter += 1
    request_id = counter
    process.stdin.write(json.dumps({'jsonrpc':'2.0','id':request_id,'method':method,'params':params})+'\n'); process.stdin.flush()
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        message=events.get(timeout=max(.01,deadline-time.monotonic()))
        if message.get('id') == request_id:
            if 'error' in message: raise RuntimeError(str(message['error']))
            return message['result']
    raise TimeoutError(method)
def call(name, args):
    result=rpc('tools/call', {'name':name,'arguments':args})
    text=''.join(c.get('text','') for c in result.get('content',[]))
    parsed=json.loads(text)
    if not parsed.get('ok'): raise RuntimeError(str(parsed))
    return parsed
state_path=pathlib.Path('/home/spooky/.local/share/acpbot/selective-check.json')
try:
    rpc('initialize', {'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'selective-bridge-check','version':'1'}})
    process.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');process.stdin.flush()
    print('MCP tools:', ', '.join(t['name'] for t in rpc('tools/list',{})['tools']),flush=True)
    if len(sys.argv)>1 and sys.argv[1]=='ask-live':
        import uuid
        state=json.loads(state_path.read_text())
        reply=call('telegram_ask', {'binding_id':state['binding_id'],'request_id':str(uuid.uuid4()),'question':'Повторная проверка: ответь TG_OK_2 в этой теме. MCP сейчас блокирующе ждёт твой ответ.','wait_seconds':45})
        state_path.write_text(json.dumps({'binding_id':state['binding_id'],'question_id':reply['question_id']}))
        print('Blocking answer:',json.dumps(reply,ensure_ascii=False),flush=True)
    elif len(sys.argv)>1 and sys.argv[1]=='wait':
        state=json.loads(state_path.read_text())
        reply=call('telegram_wait_reply', {**state,'wait_seconds':45})
        print('Reply:',json.dumps(reply,ensure_ascii=False),flush=True)
    else:
        connected=call('telegram_connect', {'agent':'mimo','session_id':'selective-mcp-verification','name':'MCP проверка','repo_root':'/data/projects/playground'})
        binding={'binding_id':connected['binding_id']}
        call('telegram_notify',{**binding,'text':'Проверка: выборочные уведомления через MCP работают. Полная переписка и мысли не пересылаются.'})
        call('telegram_send_file',{**binding,'path':'output/telegram-bridge-check.txt','caption':'Проверка файла через новый MCP'})
        call('telegram_send_photo',{**binding,'path':'output/telegram-bridge-check.png','caption':'Проверка изображения через новый MCP'})
        answer=call('telegram_ask',{**binding,'question':'Проверка ожидания ответа: напиши TG_OK в этой теме. Ответ должен вернуться в исходный MCP-вызов.','request_id':'selective-verification-1','wait_seconds':0})
        state_path.write_text(json.dumps({**binding,'question_id':answer['question_id']}));state_path.chmod(0o600)
        print('Question sent once; binding and question IDs saved privately.',flush=True)
finally:
    process.terminate()
    try:process.wait(timeout=3)
    except subprocess.TimeoutExpired:process.kill()
