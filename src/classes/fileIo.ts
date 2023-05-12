import { EncodeObject } from '@cosmjs/proto-signing'
import { random } from 'make-random'

import { hashAndHex, merkleMeBro } from '@/utils/hash'
import {
  genIv,
  genKey,
  stringToAes
} from '@/utils/crypt'
import {
  bruteForceString,
  getFileTreeData,
  handlePagination,
  setDelay,
  stripper
} from '@/utils/misc'
import FileDownloadHandler from '@/classes/fileDownloadHandler'
import FolderHandler from '@/classes/folderHandler'
import {
  IFileDownloadHandler,
  IFileIo,
  IFileUploadHandler,
  IFolderHandler,
  IProtoHandler,
  IWalletHandler
} from '@/interfaces/classes'
import {
  IChildDirInfo,
  IDownloadDetails,
  IFileConfigRaw,
  IFiletreeParsedContents,
  IFolderFrame,
  IMiner,
  IMsgPartialPostFileBundle,
  IProviderModifiedResponse,
  IProviderResponse,
  IProviderVersionResponse,
  IQueueItemPostUpload,
  IStaggeredTracker,
  IUploadList,
  IUploadListItem
} from '@/interfaces'
import IProviderChecks from '@/interfaces/IProviderChecks'
import { QueryFindFileResponse } from 'jackal.js-protos/src/postgen/canine_chain/storage/query'
import SuccessIncluded from 'jackal.js-protos/src/types/TSuccessIncluded'
import {
  buildPostFile,
  makePermsBlock,
  readCompressedFileTree,
  removeCompressedFileTree
} from '@/utils/compression'
import IFileMetaHashMap from '../interfaces/file/IFileMetaHashMap'
import { Files } from 'jackal.js-protos/src/postgen/canine_chain/filetree/files'
import { FidCid } from 'jackal.js-protos/dist/postgen/canine_chain/storage/fid_cid'
import { Contracts } from 'jackal.js-protos/dist/postgen/canine_chain/storage/contracts'
import { Strays } from 'jackal.js-protos/dist/postgen/canine_chain/storage/strays'

export default class FileIo implements IFileIo {
  private readonly walletRef: IWalletHandler
  private readonly pH: IProtoHandler
  private availableProviders: IMiner[]
  private currentProvider: IMiner

  private constructor(
    wallet: IWalletHandler,
    providers: IMiner[],
    currentProvider: IMiner
  ) {
    this.walletRef = wallet
    this.pH = wallet.getProtoHandler()
    this.availableProviders = providers
    this.currentProvider = currentProvider
  }

  static async trackIo(
    wallet: IWalletHandler,
    versionFilter?: string | string[]
  ): Promise<FileIo> {
    const providers = await verifyProviders(
      await getProviders(wallet.getProtoHandler()),
      wallet.chainId,
      versionFilter
    )
    const provider = providers[await random(providers.length)]
    return new FileIo(wallet, providers, provider)
  }
  static async checkProviders(
    wallet: IWalletHandler,
    versionFilter?: string | string[]
  ): Promise<IProviderChecks> {
    const raw = await fetchProviders(wallet.getProtoHandler())
    const filtered = await filterProviders(raw)
    return {
      filtered,
      raw,
      verified: versionFilter
        ? await verifyProviders(filtered, wallet.chainId, versionFilter)
        : filtered
    }
  }

  getCurrentProvider(): IMiner {
    return this.currentProvider
  }
  getAvailableProviders(): IMiner[] {
    return this.availableProviders
  }
  forceProvider(toSet: IMiner): void {
    this.currentProvider = toSet
  }
  async clearProblems(exclude: string): Promise<void> {
    this.availableProviders = this.availableProviders.filter(
      (prov) => prov.ip !== exclude
    )
    await this.shuffle()
  }
  async shuffle(): Promise<void> {
    this.currentProvider =
      this.availableProviders[await random(this.availableProviders.length)]
  }
  async refresh(): Promise<void> {
    this.availableProviders = await verifyProviders(
      await getProviders(this.pH),
      this.walletRef.chainId
    )
    this.currentProvider =
      this.availableProviders[await random(this.availableProviders.length)]
  }

  async createFolders(
    parentDir: IFolderHandler,
    newDirs: string[]
  ): Promise<void> {
    const readyToBroadcast = await this.rawCreateFolders(parentDir, newDirs)
    const memo = ``
    // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
    await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: false })
  }
  async rawCreateFolders(
    parentDir: IFolderHandler,
    newDirs: string[]
  ): Promise<EncodeObject[]> {
    const result = await parentDir.addChildDirs(newDirs, this.walletRef)
    if (result.existing.length > 0) {
      console.log(
        'The following duplicate folder names were ignored: ',
        result.existing
      )
    }
    return result.encoded
  }
  async verifyFoldersExist(toCheck: string[]): Promise<number> {
    const toCreate = []
    for (let i = 0; i < toCheck.length; i++) {
      const check = await this.checkFolderIsFileTree(`s/${toCheck[i]}`)
      if (check) {
        console.info(`${toCheck[i]} exists`)
      } else {
        console.warn(`${toCheck[i]} does not exist`)
        toCreate.push(toCheck[i])
      }
    }
    if (toCreate.length) {
      console.log('Creating: ', toCreate)
      await this.generateInitialDirs(null, toCreate)
    }
    return toCreate.length
  }
  async staggeredUploadFiles(
    sourceHashMap: IUploadList,
    parent: IFolderHandler,
    tracker: IStaggeredTracker
  ): Promise<void> {
    const sourceKeys = Object.keys(sourceHashMap)
    const jackalAddr = this.walletRef.getJackalAddress()
    let queueHashMap: { [key: string]: boolean } = {}
    for (let key of sourceKeys) {
      queueHashMap[key] = false
    }
    await Promise.any(
      Object.values(sourceHashMap).map(async (bundle: IUploadListItem) => {
        const { exists, handler, key, uploadable } = bundle
        const existing = exists
          ? await prepExistingUpload(handler, jackalAddr, this.walletRef)
          : { cfg: null, file: null }
        bundle.data = existing.cfg
        const prom = await this.tumbleUpload(
          jackalAddr,
          existing.file || uploadable
        )
        handler.setIds(prom)
        sourceHashMap[key].handler = handler
        queueHashMap[key] = true
        tracker.complete++
        return 'Done'
      })
    ).catch((err) => {
      console.warn('All Uploads Failed')
      console.error(err)
      alert('All Uploads Failed')
    })
    do {
      await statusCheck(sourceKeys.length, tracker)
      const processingNames: any[] = Object.keys(queueHashMap).filter(
        (name) => queueHashMap[name]
      )
      const processValues = processingNames.map((name) => sourceHashMap[name])
      if (processingNames.length === 0) {
        // do nothing
      } else {
        const fileNames = processValues.reduce((acc, curr) => {
          acc[curr.handler.getWhoAmI()] = {
            name: '',
            lastModified: 0,
            size: 0,
            type: ''
          }
          return acc
        }, {} as IFileMetaHashMap)
        const readyToBroadcast = await this.rawAfterUpload(processValues)
        readyToBroadcast.push(
          await parent.addChildFileReferences(fileNames, this.walletRef)
        )
        const memo = `Processing batch of ${processValues.length} uploads`
        // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
        await this.pH
          .debugBroadcaster(readyToBroadcast, { memo, step: false })
          .catch((err) => {
            throw err
          })
        for (let key of processingNames) {
          delete queueHashMap[key]
        }
      }
    } while (Object.keys(queueHashMap).length > 0)
  }
  private async afterUpload(ids: IQueueItemPostUpload[]): Promise<void> {
    const readyToBroadcast = await this.rawAfterUpload(ids)
    const memo = ``
    // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
    await this.pH
      .debugBroadcaster(readyToBroadcast, { memo, step: false })
      .catch((err) => {
        throw err
      })
  }
  private async rawAfterUpload(
    ids: IQueueItemPostUpload[]
  ): Promise<EncodeObject[]> {
    const creator = this.walletRef.getJackalAddress()
    const needingReset: EncodeObject[] = []
    const ready = await Promise.all(
      ids.flatMap(async (item: IQueueItemPostUpload) => {
        const { cid, fid } = item.handler.getIds()
        const common = {
          aes: await item.handler.getEnc(),
          num: self.crypto.randomUUID(),
          pubKey: this.walletRef.getPubkey(),
          usr: this.walletRef.getJackalAddress()
        }

        const msgPostFileBundle: IMsgPartialPostFileBundle = {
          creator,
          account: await hashAndHex(creator),
          hashParent: await item.handler.getMerklePath(),
          hashChild: await hashAndHex(item.handler.getWhoAmI()),
          contents: JSON.stringify({ fids: fid }),
          viewers: JSON.stringify(
            await makePermsBlock({ base: 'v', ...common }, this.walletRef)
          ),
          editors: JSON.stringify(
            await makePermsBlock({ base: 'e', ...common }, this.walletRef)
          ),
          trackingNumber: common.num
        }
        if (item.data) {
          msgPostFileBundle.viewers = item.data.viewingAccess
          msgPostFileBundle.editors = item.data.editAccess
          msgPostFileBundle.trackingNumber = item.data.trackingNumber
          const delItem = await this.makeDelete(creator, [
            `${item.handler.getWhereAmI()}/${item.handler.getWhoAmI()}`
          ])
          needingReset.push(...delItem)
        }
        const msgPost: EncodeObject = await buildPostFile(
          msgPostFileBundle,
          this.pH
        )
        const msgSign: EncodeObject = this.pH.storageTx.msgSignContract({
          creator,
          cid,
          payOnce: false
        })
        return [msgPost, msgSign]
      })
    )
    ready.unshift(ready.pop() as EncodeObject[])
    return [...needingReset, ...ready.flat()]
  }
  async downloadFolder(rawPath: string): Promise<IFolderHandler> {
    const owner = this.walletRef.getJackalAddress()
    try {
      const data = (await readCompressedFileTree(
        owner,
        rawPath,
        this.walletRef
      ).catch((err: Error) => {
        throw err
      })) as IFolderFrame
      return await FolderHandler.trackFolder(data)
    } catch (err) {
      console.error(err)
      const legacyBundle: IDownloadDetails = {
        rawPath,
        owner,
        isFolder: true
      }
      const legacyHandler = await this.downloadFile(legacyBundle, {
        track: 0
      }).catch(async (err: Error) => {
        console.error('downloadFolder() : ', err)
        if (err.message.includes('All file fetch() attempts failed!')) {
          console.warn('Rebuilding ', rawPath)
          const parts = rawPath.split('/')
          const child = parts.pop() as string
          const folderDetails: IChildDirInfo = {
            myName: child,
            myParent: parts.join('/'),
            myOwner: owner
          }
          return await FolderHandler.trackNewFolder(folderDetails)
        }
      })
      return legacyHandler as IFolderHandler
    }
  }
  async downloadFile(
    downloadDetails: IDownloadDetails,
    completion: { track: number }
  ): Promise<IFileDownloadHandler | IFolderHandler> {
    const { rawPath, owner, isFolder } = downloadDetails
    const {
      success,
      value: { files }
    } = await getFileTreeData(rawPath, owner, this.pH)
    if (!success) throw new Error('No Existing File')
    const { contents, editAccess, viewingAccess, trackingNumber } =
      files as Files
    let parsedContents: IFiletreeParsedContents
    try {
      parsedContents = JSON.parse(contents)
    } catch (err) {
      console.warn('downloadFile() : ', rawPath)
      console.error(err)
      alert(err)
      parsedContents = { fids: [] }
    }
    const fid = parsedContents.fids[0]
    const fileProviders = verifyFileProviderIps(
      await this.pH.storageQuery.queryFindFile({ fid })
    )
    if (fileProviders && fileProviders.length) {
      const config = {
        editAccess: JSON.parse(editAccess),
        viewingAccess: JSON.parse(viewingAccess),
        trackingNumber: trackingNumber
      }
      const requester = await hashAndHex(
        `v${trackingNumber}${this.walletRef.getJackalAddress()}`
      )
      for (let i = 0; i < fileProviders.length; i++) {
        const url = `${fileProviders[i].replace(/\/+$/, '')}/download/${fid}`
        try {
          const resp = await fetch(url)
          const contentLength = resp.headers.get('Content-Length')
          if (!resp.body) throw new Error()
          const reader = resp.body.getReader()
          let receivedLength = 0
          let chunks = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            chunks.push(value)
            receivedLength += value.length
            completion.track =
              Math.floor((receivedLength / Number(contentLength)) * 100) || 1
          }
          const rawFile = new Blob(chunks)
          const { key, iv } = await stringToAes(
            this.walletRef,
            config.viewingAccess[requester]
          )
          if (isFolder) {
            return await FolderHandler.trackLegacyFolder(rawFile, key, iv)
          } else {
            return await FileDownloadHandler.trackFile(rawFile, config, key, iv)
          }
        } catch (err) {
          const attempt = i + 1
          const remaining = fileProviders.length - attempt
          console.warn(
            `File fetch() failed. Attempt #${attempt}. ${remaining} attempts remaining`
          )
          console.error(err)
          console.warn(`Bad file provider url: ${url}`)
        }
      }
      throw new Error('All file fetch() attempts failed!')
    } else {
      throw new Error('No available providers!')
    }
  }
  async deleteTargets(
    targets: string[],
    parent: IFolderHandler
  ): Promise<void> {
    const readyToBroadcast = await this.rawDeleteTargets(targets, parent)
    const existingDirs = parent.getChildDirs()
    const existingFiles = parent.getChildFiles()
    const dirs = targets.filter((target) => existingDirs.includes(target))
    const files = targets.filter((target) =>
      Object.keys(existingFiles).includes(target)
    )
    readyToBroadcast.push(
      await parent.removeChildDirAndFileReferences(dirs, files, this.walletRef)
    )
    const memo = ``
    // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
    await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: false })
  }
  async rawDeleteTargets(
    targets: string[],
    parent: IFolderHandler
  ): Promise<EncodeObject[]> {
    const existingDirs = parent.getChildDirs()
    const existingFiles = parent.getChildFiles()
    const dirs = targets.filter((target) => existingDirs.includes(target))
    const files = targets.filter((target) =>
      Object.keys(existingFiles).includes(target)
    )
    const location = `${parent.getWhereAmI()}/${parent.getWhoAmI()}`
    const encoded: EncodeObject[] = []
    await Promise.all(
      dirs.map(async (name) => {
        const path = `${location}/${name}`
        if (await this.checkFolderIsFileTree(path)) {
          encoded.push(await removeCompressedFileTree(path, this.walletRef))
        } else {
          encoded.push(
            ...(await this.makeDelete(this.walletRef.getJackalAddress(), [
              path
            ]))
          )
        }
      })
    )
    await Promise.all(
      files.map(async (name) => {
        encoded.push(
          ...(await this.makeDelete(this.walletRef.getJackalAddress(), [
            `${location}/${name}`
          ]))
        )
      })
    )
    for (let dir of dirs) {
      const folder = await this.downloadFolder(`${location}/${dir}`)
      const moreTargets = [
        ...new Set([
          ...folder.getChildDirs(),
          ...Object.keys(folder.getChildFiles())
        ])
      ]
      encoded.push(...(await this.rawDeleteTargets(moreTargets, folder)))
    }
    return encoded
  }
  async generateInitialDirs(
    initMsg: EncodeObject | null,
    startingDirs?: string[]
  ): Promise<void> {
    const readyToBroadcast = await this.rawGenerateInitialDirs(
      initMsg,
      startingDirs
    )
    const memo = ``
    // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
    await this.pH
      .debugBroadcaster(readyToBroadcast, { memo, step: false })
      .catch((err) => {
        console.error('generateInitialDirs() -', err)
      })
  }
  async rawGenerateInitialDirs(
    initMsg: EncodeObject | null,
    startingDirs?: string[]
  ): Promise<EncodeObject[]> {
    const toGenerate = startingDirs || ['Config', 'Home', 'WWW']
    const creator = this.walletRef.getJackalAddress()
    const dirMsgs: EncodeObject[] = await Promise.all(
      toGenerate.map(async (pathName: string) => {
        return await this.createFileTreeFolderMsg(pathName, 's', creator)
      })
    )
    const readyToBroadcast: EncodeObject[] = []
    if (initMsg) {
      readyToBroadcast.push(initMsg)
    }
    readyToBroadcast.push(await this.createRoot(), ...dirMsgs)
    return readyToBroadcast
  }
  async convertFolderType(rawPath: string): Promise<void> {
    const readyToBroadcast = await this.rawConvertFolderType(rawPath)
    const memo = ``
    // await this.pH.debugBroadcaster(readyToBroadcast, { memo, step: true })
    await this.pH
      .debugBroadcaster(readyToBroadcast, { memo, step: false })
      .catch((err) => {
        console.error('convertFolderType() -', err)
      })
  }
  async rawConvertFolderType(rawPath: string): Promise<EncodeObject[]> {
    const base = await this.downloadFolder(rawPath)
    const encoded: EncodeObject[] = []
    if (await this.checkFolderIsFileTree(rawPath)) {
      // do nothing
    } else {
      encoded.push(
        ...(await this.makeDelete(this.walletRef.getJackalAddress(), [
          base.getMyPath()
        ]))
      )
    }
    encoded.push(await base.getForFiletree(this.walletRef))

    const existingDirs = base.getChildDirs()
    for (let dir of existingDirs) {
      encoded.push(
        ...(await this.rawConvertFolderType(base.getMyChildPath(dir)))
      )
    }
    return encoded
  }
  async checkFolderIsFileTree(rawPath: string): Promise<boolean> {
    const owner = this.walletRef.getJackalAddress()
    try {
      // return value intentionally ignored
      const data = await readCompressedFileTree(owner, rawPath, this.walletRef)
      return true
    } catch (err) {
      console.warn('checkFolderIsFileTree()', err)
      return false
    }
  }

  private async createFileTreeFolderMsg(
    pathName: string,
    parentPath: string,
    creator: string
  ) {
    const folderDetails: IChildDirInfo = {
      myName: stripper(pathName),
      myParent: parentPath,
      myOwner: creator
    }
    const handler = await FolderHandler.trackNewFolder(folderDetails)
    return await handler.getForFiletree(this.walletRef)
  }
  private async makeDelete(
    creator: string,
    targets: string[]
  ): Promise<EncodeObject[]> {
    const readyToDelete: EncodeObject[][] = await Promise.all(
      targets.map(async (rawPath: string) => {
        const fileTreeResult = (
          await getFileTreeData(rawPath, creator, this.pH)
        ).value.files as Files
        const { fids = [] } = JSON.parse(fileTreeResult.contents)
        const { cids } = (
          await this.pH.storageQuery.queryFidCid({ fid: fids[0] })
        ).value.fidCid as FidCid
        const linkedCids = JSON.parse(cids)
        const toRemove: string[] = await Promise.all(
          linkedCids.filter(async (cid: string) => {
            return await matchOwnerToCid(this.pH, cid, creator)
          })
        )
        const cancelContractsMsgs: EncodeObject[] = toRemove.map(
          (cid: string) => this.pH.storageTx.msgCancelContract({ creator, cid })
        )
        const msgDelFile = this.pH.fileTreeTx.msgDeleteFile({
          creator,
          hashPath: await merkleMeBro(rawPath),
          account: await hashAndHex(creator)
        })
        return [...cancelContractsMsgs, msgDelFile]
      })
    )
    return readyToDelete.flat()
  }
  private async tumbleUpload(
    sender: string,
    file: File
  ): Promise<IProviderModifiedResponse> {
    while (this.availableProviders.length > 0) {
      const { ip } = this.currentProvider
      console.log('Current Provider:', ip)
      const url = `${ip.replace(/\/+$/, '')}/upload`
      try {
        return await doUpload(url, sender, file)
      } catch (err) {
        console.warn(err)
        await this.clearProblems(ip)
        continue
      }
    }
    console.log('Provider Options Exhausted')
    return { fid: [''], cid: '' }
  }
  private async createRoot() {
    const common = {
      aes: {
        iv: genIv(),
        key: await genKey()
      },
      num: self.crypto.randomUUID(),
      pubKey: this.walletRef.getPubkey(),
      usr: this.walletRef.getJackalAddress()
    }
    return this.pH.fileTreeTx.msgMakeRootV2({
      creator: this.walletRef.getJackalAddress(),
      editors: JSON.stringify(
        await makePermsBlock({ base: 'e', ...common }, this.walletRef)
      ),
      viewers: JSON.stringify(
        await makePermsBlock({ base: 'v', ...common }, this.walletRef)
      ),
      trackingNumber: common.num
    })
  }
}

/** Helpers */
async function prepExistingUpload(
  data: IFileUploadHandler,
  ownerAddr: string,
  walletRef: IWalletHandler
): Promise<{ file: File; cfg: IFileConfigRaw }> {
  const hexedOwner = await hashAndHex(
    `o${await data.getFullMerkle()}${await hashAndHex(ownerAddr)}`
  )
  const fileChainResult = await getFileTreeData(
    await data.getFullMerkle(),
    hexedOwner,
    walletRef.getProtoHandler()
  )
  const typedData = fileChainResult.value.files as Files

  const editPool = JSON.parse(typedData.editAccess)
  const editor = await hashAndHex(
    `e${typedData.trackingNumber}${walletRef.getJackalAddress()}`
  )
  const editorKeys = editPool[editor]

  return {
    cfg: typedData,
    file: await data.getForUpload(await stringToAes(walletRef, editorKeys))
  }
}

async function doUpload(
  url: string,
  sender: string,
  file: File
): Promise<IProviderModifiedResponse> {
  const fileFormData = new FormData()
  fileFormData.set('file', file)
  fileFormData.set('sender', sender)
  return await fetch(url, { method: 'POST', body: fileFormData as FormData })
    .then((resp): Promise<IProviderResponse> => {
      if (resp.status !== 200)
        throw new Error(`Status Message: ${resp.statusText}`)
      return resp.json()
    })
    .then((resp) => {
      return { fid: [resp.fid], cid: resp.cid }
    })
    .catch((err) => {
      throw err
    })
}

async function getProviders(
  pH: IProtoHandler,
  max?: number
): Promise<IMiner[]> {
  const rawProviderList = await fetchProviders(pH)
  console.info('Raw Providers')
  console.dir(rawProviderList)
  return filterProviders(rawProviderList, max)
}
async function fetchProviders(pH: IProtoHandler): Promise<IMiner[]> {
  return (
    await handlePagination(pH.storageQuery, 'queryProvidersAll', {})
  ).reduce((acc: IMiner[], curr: any) => {
    acc.push(...curr.providers)
    return acc
  }, [])
}
async function filterProviders(rawProviderList: IMiner[], max?: number) {
  const disallowList = [
    /example/,
    /sample/,
    /0\.0\.0\.0/,
    /127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
    /192\.168\.\d{1,3}\.\d{1,3}/,
    /placeholder/
  ]
  const filteredProviders = rawProviderList.filter((provider) => {
    const one = provider.ip.toLowerCase()
    if (one.match('localhost')) {
      return true
    } else {
      return one.startsWith('https') && !disallowList.some((rx) => rx.test(one))
    }
  })
  return filteredProviders.slice(0, Number(max) || 1000)
}
async function verifyProviders(
  providers: IMiner[],
  chainId: string,
  versionFilter?: string | string[]
): Promise<IMiner[]> {
  const versionArray: string[] = []
  if (versionFilter) {
    console.log(`Checking for provider version(s) : ${versionFilter}`)
    typeof versionFilter === 'string'
      ? versionArray.push(versionFilter as string)
      : versionArray.push(...versionFilter)
  }
  const preRegExArray: string[] = versionArray.map((s) => {
    return s.split('.').slice(0, 2).join('.')
  })
  const verRegEx = new RegExp(`(${preRegExArray.join('|')})\\..+$`)
  const staged: boolean[] = await Promise.all(
    providers.map(async (provider) => {
      const result: boolean = await fetch(
        `${provider.ip.replace(/\/+$/, '')}/version`,
        {
          signal: AbortSignal.timeout(1500)
        }
      )
        .then(async (res): Promise<boolean> => {
          const parsed: IProviderVersionResponse = await res.json()
          const chainCheck =
            chainId === undefined || chainId === parsed['chain-id']
          const verCheck =
            versionFilter === undefined || verRegEx.test(parsed.version)
          return res.ok && chainCheck && verCheck
        })
        .catch((err: Error) => {
          console.warn('verifyProviders() Error')
          console.error(err)
          if (err.message.includes('AbortSignal')) {
            alert(
              'AbortSignal.timeout() error! Chromium family version 103+ required!'
            )
          }
          return false
        })
      return result
    })
  )
  const verified = providers.filter((provider, index) => staged[index])
  console.info('Verified Providers')
  console.dir(verified)
  return verified
}
function verifyFileProviderIps(
  resp: SuccessIncluded<QueryFindFileResponse>
): string[] | false {
  if (!resp) {
    console.error('Invalid resp passed to verifyFileProviderIps()')
    return false
  }
  if (!resp.value?.providerIps) {
    console.error('Incomplete resp passed to verifyFileProviderIps()')
    return false
  }
  const brutedString = bruteForceString(resp.value.providerIps)
  if (!brutedString) {
    console.error(
      'bruteForceString() returned False in verifyFileProviderIps()'
    )
    return false
  }
  try {
    return JSON.parse(resp.value.providerIps)
  } catch (err) {
    console.error('JSON.parse() failed in verifyFileProviderIps()')
    console.error(err)
    return false
  }
}
async function matchOwnerToCid(
  pH: IProtoHandler,
  cid: string,
  owner: string
): Promise<boolean> {
  const contractsResult = (await pH.storageQuery.queryContracts({ cid })).value
    .contracts as Contracts
  if (contractsResult.signee === owner) {
    return true
  }
  const straysResult = (await pH.storageQuery.queryStrays({ cid })).value
    .strays as Strays
  return straysResult.signee === owner
}
async function statusCheck(
  target: number,
  tracker: IStaggeredTracker
): Promise<void> {
  await new Promise<void>(async (resolve) => {
    for (tracker.timer = 120; tracker.timer > 0; tracker.timer--) {
      if (tracker.complete === target) {
        resolve()
      } else {
        await setDelay(500)
      }
    }
    resolve()
  })
}
