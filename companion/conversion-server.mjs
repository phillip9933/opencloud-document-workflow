// SPDX-License-Identifier: AGPL-3.0-only
// Runs only on the installer's internal network, with no credentials or mounts.
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
export const imageExtensions = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'webp']
export const officeExtensions = [
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'txt'
]
export const extensions = [...imageExtensions, ...officeExtensions, 'xps', 'oxps']
const limit = 100 * 1024 * 1024
export async function renderPDF(bytes, extension) {
  if (!extensions.includes(extension) || !bytes.length || bytes.length > limit)
    throw Error('Unsupported or oversized conversion source')
  const dir = await mkdtemp(join(tmpdir(), 'workflow-convert-'))
  try {
    const source = join(dir, 'source.' + extension),
      output = join(dir, 'source.pdf')
    await writeFile(source, bytes, { mode: 0o600 })
    const run = (command, args) =>
      new Promise((resolve, reject) => {
        let timedOut = false,
          timer
        const kill = () => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* The process group may already have exited. */
          }
        }
        const child = execFile(
          command,
          args,
          {
            detached: true,
            maxBuffer: 1024 * 1024,
            env: { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8', TMPDIR: dir }
          },
          (error, stdout) => {
            clearTimeout(timer)
            kill()
            if (error)
              reject(
                Error(
                  timedOut
                    ? 'Conversion took too long; the original has been kept'
                    : 'The conversion tool could not read this file; the original has been kept'
                )
              )
            else resolve({ stdout })
          }
        )
        timer = setTimeout(() => {
          timedOut = true
          kill()
        }, 240000)
        timer.unref()
      })
    if (imageExtensions.includes(extension))
      await run('python3', ['/app/companion/image-to-pdf.py', source, output])
    else if (['oxps', 'xps'].includes(extension))
      await run('mutool', ['convert', '-o', output, source])
    else {
      const profile = join(dir, 'profile')
      await mkdir(join(profile, 'user'), { recursive: true })
      await writeFile(
        join(profile, 'user', 'registrymodifications.xcu'),
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item></oor:items>'
      )
      if (['xls', 'xlsx', 'ods'].includes(extension))
        await run('python3', ['/app/companion/spreadsheet-to-pdf.py', source, output, profile])
      else
        await run('libreoffice', [
          '-env:UserInstallation=' + pathToFileURL(profile).href,
          '--headless',
          '--nologo',
          '--nodefault',
          '--norestore',
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          source
        ])
    }
    const size = await stat(output)
      .then((s) => s.size)
      .catch(() => 0)
    if (size > limit) throw Error('Converted PDF exceeds limit')
    const pdf = await readFile(output).catch(() => {
      throw Error('The file could not be exported to PDF; the original has been kept')
    })
    if (pdf.length > limit || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw Error('Conversion did not produce a bounded PDF')
    const { stdout } = await run('pdfinfo', [output]),
      pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1])
    if (!pages || pages > 1000)
      throw Error('The converted PDF exceeds the 1000-page limit; the original has been kept')
    return pdf
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
export function conversionServer() {
  let active = false
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.end('ok')
      return
    }
    const extension = req.url?.match(/^\/convert\/([a-z0-9]+)$/)?.[1]
    if (req.method !== 'POST' || !extensions.includes(extension)) {
      res.writeHead(404).end()
      return
    }
    if (active) {
      res.writeHead(503).end('Converter is busy')
      return
    }
    active = true
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) throw Error('Source exceeds conversion limit')
        chunks.push(chunk)
      }
      const pdf = await renderPDF(Buffer.concat(chunks), extension)
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length })
      res.end(pdf)
    } catch (error) {
      const allowed = [
        'The file could not be exported to PDF; the original has been kept',
        'The converted PDF exceeds the 1000-page limit; the original has been kept',
        'Conversion took too long; the original has been kept',
        'The conversion tool could not read this file; the original has been kept',
        'Converted PDF exceeds limit'
      ]
      res
        .writeHead(422)
        .end(
          allowed.includes(error.message)
            ? error.message
            : 'Conversion failed; the original has been kept'
        )
    } finally {
      active = false
    }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  conversionServer().listen(5180, '0.0.0.0')
