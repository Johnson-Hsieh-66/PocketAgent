import { createInterface } from 'node:readline';

// Synthetic stdio peer. It never reads accounts, repositories or real CLI state.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const active = new Map();
const approvals = new Map();
let starts = 0;
let initializes = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
function complete(threadId, status = 'completed') {
  const turn = active.get(threadId);
  if (!turn) return;
  active.delete(threadId);
  notify('turn/completed', { threadId, turn: { ...turn, status } });
}
lines.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const approval = approvals.get(String(message.id));
    if (approval) {
      approvals.delete(String(message.id));
      notify('serverRequest/resolved', { threadId: approval.threadId, requestId: message.id });
      complete(approval.threadId, message.result.decision === 'accept' ? 'completed' : 'interrupted');
    }
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      initializes++;
      respond(id, { userAgent: 'codex-cli 0.167.0', platformFamily: 'fixture' });
      break;
    case 'initialized':
      break;
    case 'account/read':
      if (process.argv.includes('--fixture-crash-account-read')) process.exit(18);
      respond(id, { account: { type: 'chatgpt', email: 'fixture@example.invalid' } });
      break;
    case 'thread/read':
    case 'thread/resume': {
      if (method === 'thread/resume' && params.threadId === 'writer-conflict-thread') {
        send({ id, error: { code: -32600, message: 'thread 00000000-0000-4000-8000-000000000000 already has an active writer', data: { privatePath: 'C:\\Users\\example\\private\\synthetic.jsonl' } } });
        break;
      }
      const threadId = params.threadId;
      const turn = { id: 'fixture-resumed-turn', status: 'inProgress', items: [] };
      active.set(threadId, turn);
      // A resumed thread can already be active without a new turn/started notification.
      respond(id, { thread: { id: threadId, status: { type: 'active' }, turns: [] } });
      break;
    }
    case 'thread/turns/list':
      respond(id, { data: active.has(params.threadId) ? [active.get(params.threadId)] : [], nextCursor: null });
      break;
    case 'fixture/echo':
      setTimeout(() => respond(id, { value: params.value }), params.delay ?? 0);
      break;
    case 'fixture/stats':
      respond(id, { starts, initializes, active: [...active.keys()], approvals: approvals.size });
      break;
    case 'fixture/error':
      send({ id, error: { code: -32602, message: 'Synthetic upstream diagnostic that must stay private' } });
      break;
    case 'fixture/complete':
      complete(params.threadId);
      respond(id, {});
      break;
    case 'fixture/crash':
      process.exit(17);
      break;
    case 'turn/start': {
      const mode = params.input?.[0]?.text;
      if (mode === 'writer-conflict') {
        send({ id, error: { code: -32600, message: 'thread 00000000-0000-4000-8000-000000000000 already has an active writer', data: { privatePath: 'C:\\Users\\example\\private\\synthetic.jsonl' } } });
        break;
      }
      if (mode === 'reject-start') {
        send({ id, error: { code: -32602, message: 'Synthetic request rejection before execution' } });
        break;
      }
      if (mode === 'crash-during-start') process.exit(19);
      const turn = { id: `fixture-turn-${++starts}`, status: 'inProgress', items: [] };
      active.set(params.threadId, turn);
      notify('turn/started', { threadId: params.threadId, turn });
      if (mode === 'complete-before-response') {
        complete(params.threadId);
        setTimeout(() => respond(id, { turn }), 10);
      } else {
        respond(id, { turn });
        if (mode === 'approval') {
          const approvalId = `fixture-approval-${starts}`;
          approvals.set(approvalId, { threadId: params.threadId });
          send({
            id: approvalId,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: params.threadId, turnId: turn.id, itemId: 'fixture-command', command: 'echo fixture', availableDecisions: ['accept', 'decline', 'cancel'] },
          });
        }
      }
      break;
    }
    case 'turn/interrupt': {
      const turn = active.get(params.threadId);
      if (!turn || turn.id !== params.turnId) {
        send({ id, error: { code: -32602, message: 'No matching fixture turn' } });
      } else {
        complete(params.threadId, 'interrupted');
        respond(id, {});
      }
      break;
    }
    default:
      send({ id, error: { code: -32601, message: 'Unknown synthetic method' } });
  }
});
lines.on('close', () => process.exit(0));
