// Entry untuk bundle Raydium SDK v2 (dibangun oleh scripts/build-vendor.js).
// Diekspos sebagai global window.RaydiumSDK dan dimuat lazy oleh dashboard.
import {
  Raydium,
  TxVersion,
  Percent,
  TickUtil,
  PoolUtils,
  LiquidityMathUtil,
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  DEVNET_PROGRAM_ID,
  DEV_API_URLS,
  API_URLS,
  getCpmmPdaAmmConfigId,
  getTransferAmountFeeV2,
  fetchMultipleMintInfos,
} from '@raydium-io/raydium-sdk-v2';
import Decimal from 'decimal.js';
import BN from 'bn.js';

window.RaydiumSDK = {
  Raydium,
  TxVersion,
  Percent,
  TickUtil,
  PoolUtils,
  LiquidityMathUtil,
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  DEVNET_PROGRAM_ID,
  DEV_API_URLS,
  API_URLS,
  getCpmmPdaAmmConfigId,
  getTransferAmountFeeV2,
  fetchMultipleMintInfos,
  Decimal,
  BN,
};
