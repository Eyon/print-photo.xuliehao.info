<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

type JobStatus = 'pending' | 'claimed' | 'printed' | 'failed'

interface UploadResponse {
  uploadId: string
  storeId: string
  originalName: string
  size: number
  previewUrl: string
  printUrl: string
  createdAt: string
  expiresAt: string
}

interface JobCreateResponse {
  jobId: string
  status: JobStatus
  statusUrl: string
  createdAt: string
  storeId: string
}

interface JobResponse {
  id: string
  storeId: string
  status: JobStatus
  originalName: string
  size: number
  createdAt: string
  updatedAt: string
  imageExpiresAt?: string
  printedAt?: string
  failedAt?: string
  errorMessage?: string
}

interface WechatJsConfig {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
  jsApiList: string[]
}

interface WechatSdk {
  config(config: WechatJsConfig & { debug?: boolean }): void
  ready(callback: () => void): void
  error(callback: (error: unknown) => void): void
  chooseMedia?: (options: {
    count: number
    mediaType: string[]
    sourceType: string[]
    sizeType: string[]
    camera: 'back' | 'front'
    success: (result: { tempFiles: Array<{ tempFilePath: string; size?: number }> }) => void
    fail?: (error: unknown) => void
    cancel?: () => void
  }) => void
  chooseImage(options: {
    count: number
    sizeType: string[]
    sourceType: string[]
    success: (result: { localIds: string[] }) => void
    fail?: (error: unknown) => void
    cancel?: () => void
  }): void
  uploadImage(options: {
    localId: string
    isShowProgressTips: number
    success: (result: { serverId: string }) => void
    fail?: (error: unknown) => void
  }): void
}

declare global {
  interface Window {
    wx?: WechatSdk
  }
}

const isWechat = /MicroMessenger/i.test(navigator.userAgent)
const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
const storeId = new URLSearchParams(window.location.search).get('storeId')?.trim() || 'home'
const isWechatReady = ref(false)
const useWechatSdk = ref(isWechat && !isLocalhost)
const isBusy = ref(false)
const message = ref(useWechatSdk.value ? '正在准备微信上传环境' : '请选择一张照片')
const errorMessage = ref('')
const pendingUpload = ref<UploadResponse | null>(null)
const currentJob = ref<JobResponse | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let pollTimer: number | undefined
const printStartNotice = '打印任务会在 5 秒内开始，如果未能开始，请联系店长。'

const canPickImage = computed(() => !isBusy.value && (!useWechatSdk.value || isWechatReady.value))
const canConfirmPrint = computed(() => Boolean(pendingUpload.value) && !currentJob.value && !isBusy.value)
const visibleMessage = computed(() => (message.value === '请选择一张照片' ? '' : message.value))
const pickButtonText = computed(() => {
  if (isBusy.value) {
    return '处理中'
  }

  return pendingUpload.value ? '重新选择照片' : '选择照片'
})

const loadWechatSdk = () =>
  new Promise<void>((resolve, reject) => {
    if (window.wx) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('微信 JS-SDK 加载失败'))
    document.head.appendChild(script)
  })

const readApiError = async (response: Response) => {
  const data = await response.json().catch(() => null)
  return data?.error || `请求失败：${response.status}`
}

const getErrorText = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error && 'errMsg' in error && typeof error.errMsg === 'string') {
    return error.errMsg
  }

  return fallback
}

const isSelectionCancel = (error: unknown) => /cancel|取消/i.test(getErrorText(error, ''))

const stopPolling = () => {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

const clearPrintState = () => {
  stopPolling()
  pendingUpload.value = null
  currentJob.value = null
}

const configureWechatSdk = async () => {
  await loadWechatSdk()

  const pageUrl = window.location.href.split('#')[0] ?? window.location.href
  const response = await fetch(`/api/wechat/js-config?url=${encodeURIComponent(pageUrl)}`)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const config = (await response.json()) as WechatJsConfig

  await new Promise<void>((resolve, reject) => {
    window.wx?.config({
      ...config,
      debug: false,
    })

    window.wx?.ready(() => resolve())
    window.wx?.error((error) => reject(error instanceof Error ? error : new Error('微信 JS-SDK 配置失败')))
  })

  isWechatReady.value = true
  message.value = '请选择一张照片'
}

const updateJob = async (statusUrl: string) => {
  const response = await fetch(statusUrl)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  currentJob.value = (await response.json()) as JobResponse
}

const startPolling = (statusUrl: string) => {
  stopPolling()

  pollTimer = window.setInterval(() => {
    void updateJob(statusUrl).catch(() => undefined)

    if (currentJob.value?.status === 'printed' || currentJob.value?.status === 'failed') {
      stopPolling()
    }
  }, 2500)
}

const setPendingUpload = (upload: UploadResponse) => {
  stopPolling()
  currentJob.value = null
  pendingUpload.value = upload
  message.value = '照片已上传，请确认后打印'
}

const setCreatedJob = async (job: JobCreateResponse) => {
  await updateJob(job.statusUrl)
  startPolling(job.statusUrl)
  message.value = printStartNotice
}

const importWechatMedia = async (mediaId: string, originalName = `wechat-${Date.now()}.jpg`) => {
  const response = await fetch('/api/wechat/media-import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mediaId, originalName, storeId }),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  setPendingUpload((await response.json()) as UploadResponse)
}

const getWechatMediaName = (tempFilePath: string) => {
  const extension = tempFilePath.match(/\.([a-z0-9]{1,8})(?:[?#].*)?$/i)?.[1]?.toLowerCase()
  return `wechat-${Date.now()}${extension ? `.${extension}` : '.jpg'}`
}

const uploadWechatLocalImage = async (localId: string, originalName?: string) => {
  if (!window.wx) {
    throw new Error('微信上传环境还没有准备好')
  }

  clearPrintState()
  message.value = '正在上传原图照片'

  await new Promise<void>((resolve, reject) => {
    window.wx?.uploadImage({
      localId,
      isShowProgressTips: 1,
      success: ({ serverId }) => {
        if (!serverId) {
          reject(new Error('微信上传失败'))
          return
        }

        message.value = '正在保存照片'
        importWechatMedia(serverId, originalName)
          .then(() => resolve())
          .catch((error) => reject(error))
      },
      fail: (error) => reject(new Error(getErrorText(error, '微信上传失败'))),
    })
  })
}

const chooseWechatImageOriginal = async () =>
  new Promise<string>((resolve, reject) => {
    window.wx?.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: ({ localIds }) => {
        const localId = localIds[0]
        if (!localId) {
          reject(new Error('已取消选择图片'))
          return
        }

        resolve(localId)
      },
      fail: (error) => reject(new Error(getErrorText(error, '选择图片失败'))),
      cancel: () => reject(new Error('已取消选择图片')),
    })
  })

const chooseWechatMediaOriginal = async () =>
  new Promise<string>((resolve, reject) => {
    if (!window.wx?.chooseMedia) {
      reject(new Error('当前微信版本不支持 chooseMedia'))
      return
    }

    window.wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      camera: 'back',
      success: ({ tempFiles }) => {
        const tempFilePath = tempFiles[0]?.tempFilePath
        if (!tempFilePath) {
          reject(new Error('已取消选择图片'))
          return
        }

        resolve(tempFilePath)
      },
      fail: (error) => reject(new Error(getErrorText(error, '选择图片失败'))),
      cancel: () => reject(new Error('已取消选择图片')),
    })
  })

const pickWithWechat = async () => {
  if (!window.wx || !isWechatReady.value) {
    throw new Error('微信上传环境还没有准备好')
  }

  try {
    const tempFilePath = await chooseWechatMediaOriginal()
    await uploadWechatLocalImage(tempFilePath, getWechatMediaName(tempFilePath))
  } catch (error) {
    if (isSelectionCancel(error)) {
      throw error
    }

    message.value = '正在切换微信原图上传方式'
    const localId = await chooseWechatImageOriginal()
    await uploadWechatLocalImage(localId)
  }
}

const uploadFile = async (file: File) => {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件')
  }

  const formData = new FormData()
  formData.append('image', file)
  formData.append('storeId', storeId)

  const response = await fetch('/api/uploads', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  setPendingUpload((await response.json()) as UploadResponse)
}

const confirmPrint = async () => {
  if (!pendingUpload.value) {
    return
  }

  errorMessage.value = ''
  isBusy.value = true
  message.value = '正在创建打印任务'

  try {
    const response = await fetch(pendingUpload.value.printUrl, {
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await readApiError(response))
    }

    await setCreatedJob((await response.json()) as JobCreateResponse)
  } catch (error) {
    errorMessage.value = getErrorText(error, '创建打印任务失败')
    message.value = pendingUpload.value ? '照片已上传，请确认后打印' : '请选择一张照片'
  } finally {
    isBusy.value = false
  }
}

const pickImage = async () => {
  errorMessage.value = ''

  if (!useWechatSdk.value) {
    fileInput.value?.click()
    return
  }

  isBusy.value = true
  message.value = '正在打开相册'

  try {
    await pickWithWechat()
  } catch (error) {
    errorMessage.value = isSelectionCancel(error) ? '' : getErrorText(error, '上传失败')
    message.value = '请选择一张照片'
  } finally {
    isBusy.value = false
  }
}

const onFileSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    isBusy.value = false
    message.value = '请选择一张照片'
    return
  }

  errorMessage.value = ''
  isBusy.value = true
  message.value = '正在上传照片'

  try {
    clearPrintState()
    await uploadFile(file)
  } catch (error) {
    errorMessage.value = getErrorText(error, '上传失败')
    message.value = '请选择一张照片'
  } finally {
    input.value = ''
    isBusy.value = false
  }
}

onMounted(() => {
  if (!useWechatSdk.value) {
    return
  }

  configureWechatSdk().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '微信 JS-SDK 配置失败'
    message.value = '微信接口暂不可用，请使用网页上传'
    useWechatSdk.value = false
  })
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <main class="page-shell" :class="{ 'has-preview': pendingUpload }">
    <section class="upload-panel" aria-labelledby="page-title">
      <div class="panel-topline">
        <p class="eyebrow">照片打印</p>
        <p class="store-badge">门店：{{ storeId }}</p>
      </div>
      <h1 id="page-title">上传照片后确认打印</h1>
      <p v-if="visibleMessage" class="summary">
        {{ visibleMessage }}
      </p>

      <button v-if="!pendingUpload" class="primary-action" :disabled="!canPickImage" @click="pickImage">
        {{ pickButtonText }}
      </button>

      <input
        ref="fileInput"
        class="file-input"
        type="file"
        accept="image/*"
        @change="onFileSelected"
      />

      <p v-if="errorMessage" class="error-text" role="alert">
        {{ errorMessage }}
      </p>

      <div v-if="pendingUpload" class="preview-area">
        <div class="print-preview-sheet">
          <img class="photo-preview" :src="pendingUpload.previewUrl" :alt="pendingUpload.originalName" />
        </div>

        <div class="preview-actions" :class="{ 'is-single': currentJob }">
          <button class="secondary-action" :disabled="!canPickImage" @click="pickImage">
            {{ pickButtonText }}
          </button>
          <button v-if="!currentJob" class="primary-action" :disabled="!canConfirmPrint" @click="confirmPrint">
            {{ isBusy ? '正在创建打印任务' : '确定打印' }}
          </button>
        </div>
      </div>
    </section>

    <p class="maker-credit">软件开发者微信：Yottava</p>
  </main>
</template>
