// Verify warnings never follow tool calls and modified text does not keep stale replay metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardAnswerStream } from '../lib/answergate.js';
const input = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '999 items' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '999 items' } },
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'actual-call', name: 'read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: [{type:'text'}, {type:'tool-call'}] } },
];
const assemble = (chunks) => chunks.filter(c => c.type === 'block-end').map(c => c.block);
async function collect(stream) { const out=[]; for await(const c of stream) out.push(c); return out; }
for (const [label, opts] of [['warn', {mode:'warn'}], ['bytes', {maxBytes:1}], ['chunks', {maxChunks:1}], ['buffered-finish', {maxChunks:input.length}], ['timeout', {timeoutMs:1}]]) {
  test(`tool-result adjacency survives ${label}`, async () => {
    async function* source() {
      for(const c of input) { if(label === 'timeout') await new Promise(r => setTimeout(r, 3)); yield c; }
    }
    const out = await collect(guardAnswerStream(source(), {assemble, ...opts}));
    assert.deepEqual(assemble(out), assemble(input));
    assert.deepEqual(out.filter(c => c.index === 1), input.filter(c => c.index === 1));
    const end = out.findIndex(c => c.type === 'block-end' && c.block.type === 'tool-call');
    assert.equal(out.slice(end + 1).some(c => c.type === 'text-delta' || c.blockType === 'text'), false);
    assert.equal(out.at(-1).reason.kind, 'tool-calls');
    assert.equal(out.filter(c => c.type === 'finish').length, 1);
  });
}
test('timeout warning invalidates text-only native replay', async () => {
  const textOnly = input.filter(c => c.index !== 1).map(c => c.type === 'finish' ? {...c, reason:{kind:'stop'}} : c);
  async function* source(){ yield* textOnly; }
  const out = await collect(guardAnswerStream(source(), {assemble, maxBytes:1}));
  assert.equal(assemble(out).length, 2);
  assert.equal(out.at(-1).replayState, undefined);
});
