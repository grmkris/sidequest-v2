/** One handler per Message variant, for an `update` split into groups: each group is written as
 * `({ ... }) satisfies Partial<Handlers<Message, UpdateReturn>>`, which types its handlers, and `Message.match` over the
 * groups spread together still checks that every variant is handled. */
export type Handlers<Message extends { readonly _tag: string }, Return> = {
  readonly [Tag in Message['_tag']]: (message: Extract<Message, { readonly _tag: Tag }>) => Return
}
