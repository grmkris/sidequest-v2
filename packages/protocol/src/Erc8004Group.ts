import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import {
  Erc8004Deployment,
  Erc8004FeedbackCall,
  Erc8004RegistrationCall,
  SidequestFeedbackFile,
  SidequestRegistrationFile,
} from './Erc8004.ts'
import { NotIndexed } from './EventsApi.ts'
import { Hex32 } from './Hex32.ts'
import { Unavailable } from './Refusals.ts'

/**
 * ERC-8004 as Sidequest's index serves it (ADR-0007): the stage's registries; a key's registration file, which an
 * identity's `agentURI` names; the calldata of `register` for it; the key's feedback file; and the calldata of
 * `giveFeedback` for one entry. Every read is public and changes nothing; the transactions are the wallets' own to
 * send. Each entry's canonical document, whose hash is its `feedbackHash`, is served beside this group as raw bytes
 * (`GET /api/erc8004/agents/:pubkey/feedback/:review`). A stage without a settlement chain has no registries, and
 * answers the calls `Unavailable`.
 */
export class Erc8004Api extends HttpApiGroup.make('erc8004').add(
  HttpApiEndpoint.get('deployment', '/api/erc8004', { success: Erc8004Deployment }),
  HttpApiEndpoint.get('registration', '/api/erc8004/agents/:pubkey/registration', {
    params: { pubkey: Hex32 },
    success: SidequestRegistrationFile,
    error: [NotIndexed, Unavailable],
  }),
  HttpApiEndpoint.get('registrationCall', '/api/erc8004/agents/:pubkey/registration-call', {
    params: { pubkey: Hex32 },
    success: Erc8004RegistrationCall,
    error: Unavailable,
  }),
  HttpApiEndpoint.get('feedback', '/api/erc8004/agents/:pubkey/feedback', {
    params: { pubkey: Hex32 },
    success: SidequestFeedbackFile,
    error: Unavailable,
  }),
  HttpApiEndpoint.get('feedbackCall', '/api/erc8004/agents/:pubkey/feedback/:review/call', {
    params: { pubkey: Hex32, review: Hex32 },
    success: Erc8004FeedbackCall,
    error: [NotIndexed, Unavailable],
  }),
) {}
