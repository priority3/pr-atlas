import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter } from '../src/priority-me-blog/frontmatter.js'

function block(...lines: string[]): string {
  return ['---', ...lines, '---', 'Body text.'].join('\n')
}

test('single-line scalars keep their JSON types', () => {
  const { data, body } = parseFrontmatter(
    block(
      'title: Hello World',
      'draft: false',
      'published: true',
      'count: 3',
      'ratio: 1.5',
      'empty:',
      'nothing: ~',
      'explicit: null',
    ),
  )
  assert.equal(data.title, 'Hello World')
  assert.equal(data.draft, false)
  assert.equal(data.published, true)
  assert.equal(data.count, 3)
  assert.equal(data.ratio, 1.5)
  assert.equal(data.empty, null)
  assert.equal(data.nothing, null)
  assert.equal(data.explicit, null)
  assert.equal(body, 'Body text.')
})

test('a multi-line block sequence is parsed instead of silently dropped', () => {
  // Reason: this is the regression that motivated the rewrite. The previous
  // parser only understood `tags: [a, b]` and returned no tags at all here.
  const indented = parseFrontmatter(block('tags:', '  - tech', '  - memory'))
  assert.deepEqual(indented.data.tags, ['tech', 'memory'])

  // A sequence at its key's own indentation is equally valid YAML.
  const flush = parseFrontmatter(block('tags:', '- tech', '- memory', 'title: After'))
  assert.deepEqual(flush.data.tags, ['tech', 'memory'])
  assert.equal(flush.data.title, 'After')
})

test('inline flow collections still work', () => {
  const { data } = parseFrontmatter(block('tags: [tech, "with, comma"]', 'meta: {a: 1, b: two}'))
  assert.deepEqual(data.tags, ['tech', 'with, comma'])
  assert.deepEqual(data.meta, { a: 1, b: 'two' })
})

test('nested mappings are parsed at depth', () => {
  const { data } = parseFrontmatter(
    block('author:', '  name: Alice', '  links:', '    site: https://example.com', 'title: After'),
  )
  assert.deepEqual(data.author, {
    name: 'Alice',
    links: { site: 'https://example.com' },
  })
  assert.equal(data.title, 'After')
})

test('a sequence of mappings keeps each entry whole', () => {
  const { data } = parseFrontmatter(
    block('authors:', '  - name: A', '    url: https://a.example', '  - name: B', 'title: After'),
  )
  assert.deepEqual(data.authors, [
    { name: 'A', url: 'https://a.example' },
    { name: 'B' },
  ])
  assert.equal(data.title, 'After')
})

test('block scalars preserve newlines with | and fold with >', () => {
  const literal = parseFrontmatter(block('summary: |', '  First line', '  Second line', 'title: After'))
  assert.equal(literal.data.summary, 'First line\nSecond line')
  assert.equal(literal.data.title, 'After')

  const folded = parseFrontmatter(block('summary: >', '  a', '  b', '', '  c'))
  assert.equal(folded.data.summary, 'a b\nc')

  const chomped = parseFrontmatter(block('summary: |-', '  only'))
  assert.equal(chomped.data.summary, 'only')
})

test('block scalars keep relative indentation and treat # as literal text', () => {
  const { data } = parseFrontmatter(
    block('snippet: |', '  line one', '    indented', '  # not a comment'),
  )
  assert.equal(data.snippet, 'line one\n  indented\n# not a comment')
})

test('comments are stripped without eating hashes in URLs or quotes', () => {
  const { data } = parseFrontmatter(
    block(
      '# leading comment',
      'title: Hello  # trailing comment',
      'link: https://example.com/page#anchor',
      'quoted: "has # hash"',
    ),
  )
  assert.equal(data.title, 'Hello')
  assert.equal(data.link, 'https://example.com/page#anchor')
  assert.equal(data.quoted, 'has # hash')
  assert.deepEqual(Object.keys(data), ['title', 'link', 'quoted'], 'the standalone comment adds no key')
})

test('quoted scalars are unwrapped and escapes resolved', () => {
  const { data } = parseFrontmatter(
    block('single: \'it\'\'s fine\'', 'double: "line\\nbreak"', 'blank: ""', 'numeric: "3"'),
  )
  assert.equal(data.single, "it's fine")
  assert.equal(data.double, 'line\nbreak')
  assert.equal(data.blank, '')
  assert.equal(data.numeric, '3', 'a quoted number stays a string')
})

test('values containing a colon are not mistaken for keys', () => {
  const { data } = parseFrontmatter(block('title: Hello: World', 'time: 12:30'))
  assert.equal(data.title, 'Hello: World')
  assert.equal(data.time, '12:30')
})

test('dates stay strings because capture metadata is JSON', () => {
  const { data } = parseFrontmatter(block('date: 2026-08-25'))
  assert.equal(data.date, '2026-08-25')
})

test('content without frontmatter is returned as body', () => {
  const { data, body } = parseFrontmatter('# Just Markdown\n\nNo frontmatter here.')
  assert.deepEqual(data, {})
  assert.equal(body, '# Just Markdown\n\nNo frontmatter here.')
})

test('an empty frontmatter block yields no data', () => {
  assert.deepEqual(parseFrontmatter('---\n\n---\nBody.').data, {})
})

test('unsupported YAML is rejected loudly rather than dropped', () => {
  assert.throws(() => parseFrontmatter(block('title: A', '\ttabbed: B')), /tab indentation/)
  assert.throws(() => parseFrontmatter(block('base: &anchor value')), /anchors and aliases/)
  assert.throws(() => parseFrontmatter(block('copy: *anchor')), /anchors and aliases/)
  assert.throws(() => parseFrontmatter(block('<<: other')), /merge keys/)
  assert.throws(() => parseFrontmatter(block('? complex')), /complex mapping keys/)
  assert.throws(() => parseFrontmatter(block('title: A', 'just-a-string')), /expected "key: value"/)
  assert.throws(() => parseFrontmatter(block('- one', '- two')), /must be a mapping/)
  assert.throws(() => parseFrontmatter(block('tags: [a, b')), /unterminated inline sequence/)
  assert.throws(() => parseFrontmatter(block('meta: {a: 1')), /unterminated inline mapping/)
  assert.throws(() => parseFrontmatter(block('meta: {a}')), /missing a value/)
  assert.throws(() => parseFrontmatter(block('title: A', '  stray: B')), /unexpected indentation/)
})
