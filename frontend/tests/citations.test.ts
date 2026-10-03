// Phase 4 regression: [n] markers must open the citation the server numbered n, not citations[n-1].
import test from 'node:test';
import assert from 'node:assert/strict';
import { citationForMarker } from '../src/lib/citations.ts';

const cite = (index: number | undefined, name: string) => ({ index, source_name: name });

test('markers resolve by the server-assigned index, regardless of array order', () => {
  // Answer cited passage 2 first, then 1 -> the API returns them in order of first use.
  const citations = [cite(2, 'cells.docx'), cite(1, 'biology.pdf')];
  assert.equal(citationForMarker(citations, 1)?.source_name, 'biology.pdf');
  assert.equal(citationForMarker(citations, 2)?.source_name, 'cells.docx');
});

test('an answer citing only passage 3 does not show passage 1 or leave [3] unresolved', () => {
  const citations = [cite(3, 'notes.txt')];
  assert.equal(citationForMarker(citations, 3)?.source_name, 'notes.txt');
  assert.equal(citationForMarker(citations, 1), null);
});

test('a marker with no matching citation is unresolved, never mapped to the wrong source', () => {
  const citations = [cite(1, 'a.pdf'), cite(4, 'd.pdf')];
  assert.equal(citationForMarker(citations, 2), null);
  assert.equal(citationForMarker(citations, 4)?.source_name, 'd.pdf');
});

test('legacy messages without an index fall back to position', () => {
  const citations = [cite(undefined, 'first.pdf'), cite(undefined, 'second.pdf')];
  assert.equal(citationForMarker(citations, 2)?.source_name, 'second.pdf');
  assert.equal(citationForMarker(citations, 3), null);
});
