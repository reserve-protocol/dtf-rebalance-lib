import DecimalLight from 'decimal.js-light'
import type { Decimal as DecimalType } from 'decimal.js-light'

// Create a local Decimal constructor with custom precision
const Decimal = DecimalLight.clone({ precision: 100 })

export const D27n: bigint = 10n ** 27n
export const D18n: bigint = 10n ** 18n
export const D9n: bigint = 10n ** 9n

export const D27d: DecimalType = new Decimal('1e27')
export const D18d: DecimalType = new Decimal('1e18')
export const D9d: DecimalType = new Decimal('1e9')

export const ZERO = new Decimal('0')
export const ONE = new Decimal('1')
export const TWO = new Decimal('2')

export const bn = (str: string | DecimalType): bigint => {
  return BigInt(new Decimal(str).toFixed(0))
}
