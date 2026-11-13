import { JobView } from '@sidequest/fold'
import { OpenJob } from '@sidequest/fold/api'
import { IndexListing, IndexListingDetail, Page } from '@sidequest/protocol'
import { defineTaggedUnion } from 'foldkit/schema'
import { Names } from './Names.ts'

// What the server read for the page it rendered, stamped into the document with the Flags, so hydration starts from
// the same data the HTML shows and reads nothing again. Only public reads: the server does not know who the visitor
// is, so nothing personal is ever rendered there.

/** The data of the page the server rendered, or none: a page it did not read for, or a read that failed. */
export const Preload = defineTaggedUnion({
  Nothing: {},
  Home: { requests: Page(OpenJob), listings: Page(IndexListing), names: Names },
  Listing: { listing: IndexListingDetail },
  Job: { view: JobView, names: Names },
})
export type Preload = typeof Preload.Type
