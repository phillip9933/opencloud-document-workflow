import { mount, flushPromises } from '@vue/test-utils'
import { createLocale, localeKey } from '../../src/state/locale'
const pdf = vi.hoisted(() => ({
  getPage: vi.fn(),
  getDocument: vi.fn(),
  destroy: vi.fn(),
  render: vi.fn()
}))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
import PdfPreview from '../../src/components/PdfPreview.vue'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})
it('previews documents beyond fifty pages, changes pages, and downloads the exact original Blob', async () => {
  const blob = new Blob(['original PDF bytes']),
    state = createLocale({ listen: false }),
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}),
    create = vi.fn(() => 'blob:fixture'),
    revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke })
  )
  pdf.getPage.mockResolvedValue({
    getViewport: () => ({ width: 600, height: 800 }),
    render: pdf.render.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() })
  })
  pdf.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 71, getPage: pdf.getPage }),
    destroy: pdf.destroy.mockResolvedValue(undefined)
  })
  const w = mount(PdfPreview, {
    props: { data: blob, filename: '原本.pdf', initialPage: 51 },
    global: { provide: { [localeKey as symbol]: state } }
  })
  await flushPromises()
  expect(w.text()).toContain('51 / 71')
  expect(pdf.getPage).toHaveBeenCalledWith(51)
  await w.get('[aria-label="Next page"]').trigger('click')
  await flushPromises()
  expect(pdf.getPage).toHaveBeenLastCalledWith(52)
  await w.get('[aria-label="Download PDF"]').trigger('click')
  expect(create).toHaveBeenCalledWith(blob)
  expect(click.mock.instances[0]).toHaveProperty('download', '原本.pdf')
  state.set('ja')
  await flushPromises()
  expect(w.find('[aria-label="PDFをダウンロード"]').exists()).toBe(true)
  expect(pdf.getDocument).toHaveBeenCalledTimes(1)
  w.unmount()
  state.dispose()
})
