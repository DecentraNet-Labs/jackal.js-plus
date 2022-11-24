import { DeliverTxResponse } from '@cosmjs/stargate'
import { IPayBlock, IPayData, IStorageClientUsage } from '@/interfaces'

export default interface IStorageHandler {
  buyStorage (forAddress: string, duration: string, bytes: string): Promise<DeliverTxResponse>
  getClientUsage (address: string): Promise<IStorageClientUsage>
  getClientFreeSpace (address: string): Promise<string>
  getPayData (address: string): Promise<IPayData>
  getPayBlocks (blockid: string): Promise<IPayBlock>
}
