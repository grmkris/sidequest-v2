import { describe, expect, it } from 'vitest'
import { addressOf, answerFor, etagOf, rangeOf, resolve, sharedAddressOf } from '../src/Files.ts'
import { metaFrom, parseTags } from '../src/Meta.ts'
import type { ManifestEntry } from '../src/Model.ts'

const entry = (path: string, size = 1000): ManifestEntry => ({
  path,
  sha256: 'a'.repeat(64),
  size,
  contentType: 'text/html',
})
const manifest = [entry('index.html'), entry('notes/index.html'), entry('media/film.mp4')]

describe('which file a path asks for', () => {
  it('serves the file, or a folder by its index.html', () => {
    expect(resolve(manifest, '')).toMatchObject({ kind: 'file', entry: { path: 'index.html' } })
    expect(resolve(manifest, 'notes/')).toMatchObject({ kind: 'file', entry: { path: 'notes/index.html' } })
    expect(resolve(manifest, 'media/film.mp4')).toMatchObject({ kind: 'file' })
  })

  it('redirects a folder asked for without its slash, and misses everything else', () => {
    expect(resolve(manifest, 'notes')).toEqual({ kind: 'slash', path: 'notes/' })
    expect(resolve(manifest, 'media')).toEqual({ kind: 'missing' })
    expect(resolve(manifest, 'nope.png')).toEqual({ kind: 'missing' })
  })
})

describe('addresses', () => {
  it('reads the page and the path inside it', () => {
    expect(addressOf('/spike')).toEqual({ slug: 'spike', path: undefined })
    expect(addressOf('/spike/')).toEqual({ slug: 'spike', path: '' })
    expect(addressOf('/_template/a%20b.png')).toEqual({ slug: '_template', path: 'a b.png' })
  })

  it('refuses what is not a page address', () => {
    expect(addressOf('/')).toBeUndefined()
    expect(addressOf('/Spike/')).toBeUndefined()
    expect(addressOf('/spike/%E0%A4%A')).toBeUndefined()
  })

  it('reads a share link only with a whole token', () => {
    const token = 'A'.repeat(22)
    expect(sharedAddressOf(`/s/${token}/spike/x.png`)).toEqual({ token, address: { slug: 'spike', path: 'x.png' } })
    expect(sharedAddressOf(`/s/${token}/spike`)).toEqual({ token, address: { slug: 'spike', path: undefined } })
    expect(sharedAddressOf('/s/short/spike/')).toBeUndefined()
    expect(sharedAddressOf(`/s/${token}`)).toBeUndefined()
  })
})

describe('byte ranges', () => {
  it('reads one range against the size', () => {
    expect(rangeOf('bytes=0-99', 1000)).toEqual({ offset: 0, length: 100 })
    expect(rangeOf('bytes=990-', 1000)).toEqual({ offset: 990, length: 10 })
    expect(rangeOf('bytes=-10', 1000)).toEqual({ offset: 990, length: 10 })
    expect(rangeOf('bytes=900-5000', 1000)).toEqual({ offset: 900, length: 100 })
    expect(rangeOf('bytes=-5000', 1000)).toEqual({ offset: 0, length: 1000 })
  })

  it('says when no byte can be sent, and ignores what it does not honour', () => {
    expect(rangeOf('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(rangeOf('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(rangeOf('bytes=0-1,5-9', 1000)).toBe('ignore')
    expect(rangeOf('items=0-1', 1000)).toBe('ignore')
    expect(rangeOf('bytes=9-2', 1000)).toBe('ignore')
  })
})

describe('what a request gets for a file', () => {
  const file: ManifestEntry = { ...entry('media/film.mp4'), contentType: 'video/mp4' }
  const answer = (headers: Record<string, string>) => answerFor(new Headers(headers), file)

  it('answers conditionals before ranges', () => {
    expect(answer({})).toEqual({ kind: 'whole' })
    expect(answer({ 'if-none-match': etagOf(file) })).toEqual({ kind: 'not_modified' })
    expect(answer({ 'if-none-match': `W/${etagOf(file)}, "x"` })).toEqual({ kind: 'not_modified' })
    expect(answer({ 'if-match': '"x"', range: 'bytes=0-9' })).toEqual({ kind: 'precondition_failed' })
    expect(answer({ 'if-match': '*', range: 'bytes=0-9' })).toEqual({ kind: 'part', range: { offset: 0, length: 10 } })
  })

  it('answers ranges, and the whole file when If-Range names another version', () => {
    expect(answer({ range: 'bytes=5000-' })).toEqual({ kind: 'unsatisfiable' })
    expect(answer({ range: 'bytes=0-999' })).toEqual({ kind: 'whole' })
    expect(answer({ range: 'bytes=0-9', 'if-range': '"old"' })).toEqual({ kind: 'whole' })
    expect(answer({ range: 'bytes=0-9', 'if-range': etagOf(file) })).toMatchObject({ kind: 'part' })
  })

  it('tags text weakly, because the edge compresses it and drops a strong tag', () => {
    const page = entry('index.html')
    expect(etagOf(page)).toBe(`W/"${page.sha256}"`)
    expect(etagOf(file)).toBe(`"${file.sha256}"`)
    expect(answerFor(new Headers({ 'if-none-match': etagOf(page) }), page)).toEqual({ kind: 'not_modified' })
  })
})

describe('the index line of a page', () => {
  it('reads the title, description, date and tags, whatever the attribute order', () => {
    const html = `<title>A &amp; B</title><meta content="Two &lt;things&gt;" name="description"><meta name='date' content='2026-11-13'><meta name="tags" content="Kris.gg, Research, kris.gg">`
    expect(metaFrom(html, 'spike')).toEqual({
      title: 'A & B',
      description: 'Two <things>',
      date: '2026-11-13',
      tags: ['kris.gg', 'research'],
    })
  })

  it('falls back to the name and drops a date that is not one', () => {
    expect(metaFrom('<meta name="date" content="soon">', 'spike')).toEqual({
      title: 'spike',
      description: '',
      date: '',
      tags: [],
    })
    expect(parseTags(' a, B , , c/d , 1, 2, 3, 4, 5, 6 ')).toEqual(['a', 'b', 'c-d', '1', '2', '3', '4', '5'])
  })
})
