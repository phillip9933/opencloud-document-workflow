<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-only
import { useLocale } from '../state/locale'
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist'
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc = workerURL
const { t } = useLocale()
const props = defineProps<{
    data: Blob
    filename?: string
    fullscreen?: boolean
    initialPage?: number
  }>(),
  emit = defineEmits<{ close: [] }>(),
  dialog = ref<HTMLDialogElement | null>(null),
  expanded = ref(false),
  zoom = ref('fit'),
  pageWidth = ref(600),
  canvas = ref<HTMLCanvasElement | null>(null),
  page = ref(1),
  pages = ref(0),
  error = ref(''),
  loading = ref(false)
let doc: PDFDocumentProxy | undefined,
  task: PDFDocumentLoadingTask | undefined,
  render: RenderTask | undefined,
  generation = 0
const assets = import.meta.env.DEV
  ? new URL('/pdf-assets/', import.meta.url).href
  : new URL('../pdf-assets/', import.meta.url).href
async function draw(version = generation) {
  const document = doc,
    surface = canvas.value,
    number = page.value
  if (!document || !surface) return
  render?.cancel()
  const item = await document.getPage(number)
  if (version !== generation || document !== doc || number !== page.value) return
  const base = item.getViewport({ scale: 1 }),
    scale = Math.min(1.5, 2000 / base.width, 2800 / base.height),
    viewport = item.getViewport({ scale })
  pageWidth.value = base.width
  surface.width = Math.ceil(viewport.width)
  surface.height = Math.ceil(viewport.height)
  const drawing = item.render({ canvas: surface, viewport })
  render = drawing
  await drawing.promise
}
watch(
  () => props.data,
  async (blob) => {
    const version = ++generation,
      previous = task
    loading.value = true
    error.value = ''
    pages.value = 0
    render?.cancel()
    doc = undefined
    task = undefined
    try {
      await previous?.destroy()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (version !== generation) return
      const loadingTask = getDocument({
        data: bytes,
        cMapUrl: assets + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: assets + 'standard_fonts/',
        wasmUrl: assets + 'wasm/'
      })
      task = loadingTask
      const loaded = await loadingTask.promise
      if (version !== generation) {
        await loadingTask.destroy()
        return
      }
      doc = loaded
      pages.value = loaded.numPages
      page.value = Math.max(1, Math.min(props.initialPage || 1, loaded.numPages))
      await nextTick()
      await draw(version)
    } catch (e) {
      if (
        version === generation &&
        !(e instanceof Error && e.name === 'RenderingCancelledException')
      )
        error.value = 'Preview unavailable'
    } finally {
      if (version === generation) loading.value = false
    }
  },
  { immediate: true }
)
async function turn(delta: number) {
  if (loading.value || page.value + delta < 1 || page.value + delta > pages.value) return
  const version = generation
  page.value += delta
  loading.value = true
  try {
    await draw(version)
  } catch (e) {
    if (version === generation && !(e instanceof Error && e.name === 'RenderingCancelledException'))
      error.value = 'Preview unavailable'
  } finally {
    if (version === generation) loading.value = false
  }
}
function download() {
  const url = URL.createObjectURL(props.data),
    link = document.createElement('a')
  link.href = url
  link.download = props.filename || 'document.pdf'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function expand() {
  expanded.value = true
  await nextTick()
  dialog.value?.showModal()
}
onBeforeUnmount(() => {
  dialog.value?.close()
  generation++
  render?.cancel()
  task?.destroy().catch(() => {})
})
</script>
<template>
  <section :class="['pdf-canvas', { fullscreen }]" :aria-label="t('PDF preview')">
    <div class="pdf-controls">
      <button
        class="icon-button"
        :disabled="loading || page === 1"
        :aria-label="t('Previous page')"
        :title="t('Previous page')"
        @click="turn(-1)"
      >
        ←</button
      ><span>{{ page }} / {{ pages || '…' }}</span
      ><button
        class="icon-button"
        :disabled="loading || page >= pages"
        :aria-label="t('Next page')"
        :title="t('Next page')"
        @click="turn(1)"
      >
        →</button
      ><select
        :id="fullscreen ? 'pdf-zoom-expanded' : 'pdf-zoom'"
        v-model="zoom"
        :aria-label="t('Zoom')"
      >
        <option value="fit">{{ t('Fit width') }}</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option></select
      ><button
        class="icon-button"
        :aria-label="t('Download PDF')"
        :title="t('Download PDF')"
        @click="download"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4" />
        </svg></button
      ><button
        v-if="!fullscreen"
        class="icon-button"
        :aria-label="t('Expand PDF')"
        :title="t('Expand PDF')"
        @click="expand"
      >
        ⛶</button
      ><button v-else class="icon-button" autofocus :aria-label="t('Close')" @click="emit('close')">
        ×
      </button>
    </div>
    <p v-if="loading" role="status">{{ t('Loading…') }}</p>
    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
    <canvas
      v-show="!error"
      ref="canvas"
      :style="{ width: zoom === 'fit' ? '100%' : pageWidth * Number(zoom) + 'px' }"
      :aria-label="t('PDF page {number}', { number: page })"
    />
  </section>
  <dialog
    v-if="!fullscreen"
    ref="dialog"
    :aria-label="t('Expanded PDF preview')"
    @close="expanded = false"
  >
    <PdfPreview
      v-if="expanded"
      :data="data"
      :filename="filename"
      :initial-page="page"
      fullscreen
      @close="dialog?.close()"
    />
  </dialog>
</template>
<style scoped>
.pdf-canvas {
  margin-top: 14px;
  background: var(--pdf-stage);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px;
  overflow: auto;
  max-height: min(760px, calc(100dvh - 300px));
}
.pdf-controls {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 1;
  background: var(--pdf-stage);
  padding: 6px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
}
.pdf-canvas canvas {
  display: block;
  height: auto;
  background: white;
}
.pdf-controls select {
  font-size: 12px;
  padding: 6px 8px;
}
.pdf-controls .icon-button {
  width: 30px;
  height: 30px;
  padding: 0;
  font-size: 19px;
}
.pdf-controls select {
  max-width: 110px;
}
dialog {
  border: 1px solid var(--input-border);
  border-radius: 10px;
  padding: 12px;
  width: min(1100px, 94vw);
  max-width: 94vw;
  max-height: 94dvh;
  background: var(--pdf-stage);
  color: var(--ink);
}
dialog::backdrop {
  background: #0009;
}
.pdf-canvas.fullscreen {
  max-height: calc(90dvh - 30px);
  margin: 0;
  border: 0;
}
@media (max-width: 850px) {
  .pdf-canvas:not(.fullscreen) {
    max-height: 55dvh;
  }
}
</style>
