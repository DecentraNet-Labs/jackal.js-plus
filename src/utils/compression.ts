import PLZSU from '@karnthis/plzsu'
import { IEditorsViewers, IMsgPartialPostFileBundle, IPermsParts } from '@/interfaces'
import { EncodeObject } from '@cosmjs/proto-signing'
import { aesToString, compressEncryptString, decryptDecompressString, genIv, genKey, stringToAes } from '@/utils/crypt'
import { hashAndHex, merkleMeBro } from '@/utils/hash'
import { Files } from 'jackal.js-protos/src/postgen/canine_chain/filetree/files'
import { MsgMakeRoot } from 'jackal.js-protos/src/postgen/canine_chain/filetree/tx'
import { IProtoHandler, IWalletHandler } from '@/interfaces/classes'

const Plzsu = new PLZSU()

export function compressData (input: string): string {
  return `jklpc1${Plzsu.compress(input)}`
}
export function decompressData (input: string): string {
  if (!input.startsWith('jklpc1')) throw new Error('Invalid Decompression String')
  return Plzsu.decompress(input.substring(6))
}

export async function saveCompressedFileTree (
  toAddress: string,
  rawPath: string,
  rawTarget: string,
  rawContents: { [key: string]: any },
  walletRef: IWalletHandler
): Promise<EncodeObject> {
  const aes = {
    iv: genIv(),
    key: await genKey()
  }
  const creator = walletRef.getJackalAddress()
  const account = await hashAndHex(creator)
  const msg: IMsgPartialPostFileBundle = {
    account,
    creator,
    contents: await compressEncryptString(JSON.stringify(rawContents), aes.key, aes.iv),
    hashParent: await merkleMeBro(rawPath),
    hashChild: await hashAndHex(rawTarget),
    trackingNumber: self.crypto.randomUUID(),
    editors: '',
    viewers: ''
  }
  msg.account = await hashAndHex(msg.creator)
  const basePerms: any = {
    num: msg.trackingNumber,
    aes
  }
  const selfPubKey = walletRef.getPubkey()


  const me = {
    ...basePerms,
    pubKey: selfPubKey,
    usr: creator
  }
  msg.editors = JSON.stringify(await makePermsBlock({ base: 'e', ...me }, walletRef))
  if (toAddress === creator) {
    msg.viewers = JSON.stringify(await makePermsBlock({ base: 'v', ...me }, walletRef))
  } else {
    const destPubKey = await walletRef.findPubKey(toAddress)
    const them = {
      ...basePerms,
      pubKey: destPubKey,
      usr: toAddress
    }
    msg.viewers = JSON.stringify({
      ...await makePermsBlock({ base: 'v', ...me }, walletRef),
      ...await makePermsBlock({ base: 'v', ...them }, walletRef)
    })
  }
  return buildPostFile(msg, walletRef.getProtoHandler())
}
export async function readCompressedFileTree (
  owner: string,
  rawPath: string,
  walletRef: IWalletHandler
): Promise<{ [key: string]: any }> {
  const hexAddress = await merkleMeBro(rawPath)
  const hexedOwner = await hashAndHex(`o${hexAddress}${await hashAndHex(owner)}`)
  const result = await walletRef.getProtoHandler().fileTreeQuery.queryFiles({ address: hexAddress, ownerAddress: hexedOwner })
  console.log(result)
  if (!result.success) {
    throw new Error('Share Data Not Found')
  } else {
    try {
      const { contents, viewingAccess, trackingNumber } = result.value.files as Files
      const parsedVA = JSON.parse(viewingAccess)
      console.log('parsedVA')
      console.log(parsedVA)
      const viewName = await hashAndHex(`s${trackingNumber}${walletRef.getJackalAddress()}`)
      console.log(parsedVA[viewName])
      const keys = await stringToAes(walletRef, parsedVA[viewName])
      const final = await decryptDecompressString(contents, keys.key, keys.iv)
      console.log(final)
      return JSON.parse(final)
    } catch (err: any) {
      throw err
    }
  }
}
export async function removeCompressedFileTree (
  rawPath: string,
  walletRef: IWalletHandler
): Promise<EncodeObject> {
  const creator = walletRef.getJackalAddress()
  return walletRef.getProtoHandler().fileTreeTx.msgDeleteFile({
    creator,
    hashPath: await merkleMeBro(rawPath),
    account: await hashAndHex(creator)
  })
}

/** Helpers */
function makeSharedBlock (msg: MsgMakeRoot, pH: IProtoHandler): EncodeObject {
  return pH.fileTreeTx.msgMakeRoot({
    creator: msg.creator,
    account: msg.account,
    rootHashPath: msg.rootHashPath,
    contents: msg.contents,
    editors: msg.editors,
    viewers: msg.viewers,
    trackingNumber: msg.trackingNumber
  })
}
export async function makePermsBlock (parts: IPermsParts, walletRef: IWalletHandler): Promise<IEditorsViewers> {
  const perms: IEditorsViewers = {}
  const user = await hashAndHex(`${parts.base}${parts.num}${parts.usr}`)
  const value = await aesToString(
    walletRef,
    parts.pubKey,
    parts.aes
  )
  perms[user] = value
  return perms
}

export async function buildPostFile (data: IMsgPartialPostFileBundle, pH: IProtoHandler): Promise<EncodeObject> {
  return pH.fileTreeTx.msgPostFile({
    creator: data.creator,
    account: data.account,
    hashParent: data.hashParent,
    hashChild: data.hashChild,
    contents: data.contents,
    editors: data.editors,
    viewers: data.viewers,
    trackingNumber: data.trackingNumber
  })
}
