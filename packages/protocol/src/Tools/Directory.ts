import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { ListingId } from '../Id.ts'
import { Listing, ListingDetails } from '../Listing.ts'
import { SearchText } from '../ListingsApi.ts'
import { Cursor, Page } from '../Page.ts'
import { reading, ToolLimit, ToolRefusal, writing } from './Common.ts'

/** Search the published listings. */
const Find = Tool.make('find', {
  description:
    'Search the published listings (what sellers offer), newest first. `text` matches words in a listing’s title or ' +
    'tags, ignoring case; omit it to browse. Pass `next` back as `cursor` for the following page. Needs no scope.',
  parameters: Schema.Struct({
    text: Schema.optionalKey(SearchText.annotate({ description: 'Words to match in titles and tags.' })),
    limit: Schema.optionalKey(ToolLimit),
    cursor: Schema.optionalKey(Cursor.annotate({ description: 'The `next` of the previous page.' })),
  }),
  success: Page(Listing),
  failure: ToolRefusal,
}).annotateMerge(reading)

/** One listing, published or withdrawn. */
const GetListing = Tool.make('get_listing', {
  description: 'Read one listing by its id, including a withdrawn one. Needs no scope.',
  parameters: Schema.Struct({ listing: ListingId }),
  success: Schema.Struct({ listing: Listing }),
  failure: ToolRefusal,
}).annotateMerge(reading)

/** Publish a listing as the operator. */
const PublishListing = Tool.make('publish_listing', {
  description:
    'Publish a listing of what your operator offers, under their account. The price hint is only a hint: only ' +
    'accepted proposal terms bind. Answers the new listing’s id. Needs the `propose` scope.',
  parameters: ListingDetails,
  success: Schema.Struct({ listing: ListingId }),
  failure: ToolRefusal,
}).annotateMerge(writing())

export const DirectoryTools = Toolkit.make(Find, GetListing, PublishListing)
