import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversionError, validMetric} from '../../src/conversion/convert.mjs';
import {failureCode, isPermanentConversionFailure} from '../../src/conversion/failures.mjs';
import {errorCode, traceTask, measured, conversionMetric} from '../../src/server/cloud/telemetry.ts';
import {errorDiagnostics, validatedDiagnostics} from '../../src/server/cloud/error-diagnostics.ts';

const privateText = 'SYNTHETIC_PRIVATE_DOCUMENT xoxb-test-placeholder https://private.invalid/?token=test';
test('Markdown size failure remains a permanent classified failure through task telemetry without document content', async () => {
  const reason = 'markdown_size';
  const error = new ConversionError(failureCode(reason), privateText, 'markdown');
  error.stack = `Error: ${privateText}\n    at internal (/runtime/src/conversion/convert.mjs:73:15)`;
  assert.equal(errorCode(error), 'conversion_markdown_limit');
  assert.equal(isPermanentConversionFailure(error.code), true);
  const metric = validMetric({stage: 'markdown', phase: 'failed', failureReason: reason, pageCount: 3, message: privateText, document: privateText});
  assert.deepEqual(metric, {stage: 'markdown', phase: 'failed', failureReason: reason, pageCount: 3});
  const rows = [];
  await assert.rejects(traceTask(
    {teamId: 'TSYNTHETIC', cardId: privateText, kind: 'event'},
    {signal: new AbortController().signal, checkpoint: async () => {}},
    () => measured('conversion', async () => { conversionMetric(metric); throw error; }),
    row => rows.push(row),
  ), failure => failure === error);
  assert.equal(rows.find(row => row.event === 'conversion_stage')?.failureReason, reason);
  for (const event of ['stage_finished', 'task_finished']) {
    const row = rows.find(item => item.event === event);
    assert.equal(row?.errorCode, 'conversion_markdown_limit');
    assert.deepEqual(row?.stackFrames, [{file: 'src/conversion/convert.mjs', line: 73, column: 15}]);
  }
  for (const secret of [privateText, 'SYNTHETIC_PRIVATE_DOCUMENT', 'xoxb-test-placeholder', 'private.invalid', '/runtime/', 'TSYNTHETIC']) {
    assert.equal(JSON.stringify(rows).includes(secret), false);
  }
});

test('Markdown diagnostics keep only known code locations and reject user-controlled source paths', () => {
  const error = new Error(privateText);
  error.stack = `Error: ${privateText}\n    at document (/runtime/src/conversion/markdown.mjs:29:11)\n    at document (/private/document.md:4:5)`;
  const safe = errorDiagnostics(error);
  assert.deepEqual(safe.stackFrames, [{file: 'src/conversion/markdown.mjs', line: 29, column: 11}]);
  assert.deepEqual(validatedDiagnostics(JSON.parse(JSON.stringify(safe))), safe);
  assert.equal(validatedDiagnostics({...safe, stackFrames: [{file: '/private/document.md', line: 4, column: 5}]}), undefined);
  assert.equal(JSON.stringify(safe).includes(privateText), false);
  assert.equal(errorCode({code: 'conversion_markdown_' + privateText}), 'internal');
  assert.equal(isPermanentConversionFailure('conversion_timeout'), false);
});
