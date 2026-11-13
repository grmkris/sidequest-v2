import { Schema } from 'effect'
import { ListingId } from './Id.ts'

export const onListing = { listing: ListingId }

/** What a search matches in a listing's title or tags, letter case aside. */
export const SearchText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100))
