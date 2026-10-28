import { Injectable } from '@nestjs/common';
import {
  portalOkSchema,
  type DeclinePublicInput,
  type PortalOk,
  type PortalSignatureList,
  type PublicSignatureSession,
  type SignPublicInput,
  type SignPublicResponse,
} from '@botss/shared-types';

import type { AuthedUser } from '../common/decorators/current-user.decorator';
import {
  SignaturesService,
  type ClientInfo,
  type PortalSignerRef,
} from '../signatures/signatures.service';
import { PortalScopeService } from './portal-scope';

/**
 * Signing from inside the portal. A portal person reaches only signer rows
 * addressed to their own account email, on requests in their client's
 * workspace; the emailed links keep working alongside. All signing rules
 * live in SignaturesService, shared with the link flow.
 */
@Injectable()
export class PortalSignaturesService {
  constructor(
    private readonly scope: PortalScopeService,
    private readonly signatures: SignaturesService,
  ) {}

  async list(user: AuthedUser, clientId: string): Promise<PortalSignatureList> {
    const contact = await this.scope.require(user.id, clientId);
    return this.signatures.portalList(user.email, contact.workspaceId);
  }

  async session(
    user: AuthedUser,
    clientId: string,
    signerId: string,
    client: ClientInfo,
  ): Promise<PublicSignatureSession> {
    return this.signatures.portalSession(await this.ref(user, clientId, signerId), client);
  }

  async sourceFile(user: AuthedUser, clientId: string, signerId: string) {
    return this.signatures.portalSourceFile(await this.ref(user, clientId, signerId));
  }

  async signedFile(user: AuthedUser, clientId: string, signerId: string) {
    return this.signatures.portalSignedFile(await this.ref(user, clientId, signerId));
  }

  async sign(
    user: AuthedUser,
    clientId: string,
    signerId: string,
    input: SignPublicInput,
    client: ClientInfo,
  ): Promise<SignPublicResponse> {
    return this.signatures.portalSign(await this.ref(user, clientId, signerId), input, client);
  }

  async decline(
    user: AuthedUser,
    clientId: string,
    signerId: string,
    input: DeclinePublicInput,
    client: ClientInfo,
  ): Promise<PortalOk> {
    await this.signatures.portalDecline(await this.ref(user, clientId, signerId), input, client);
    return portalOkSchema.parse({ ok: true });
  }

  private async ref(
    user: AuthedUser,
    clientId: string,
    signerId: string,
  ): Promise<PortalSignerRef> {
    const contact = await this.scope.require(user.id, clientId);
    return { signerId, email: user.email, workspaceId: contact.workspaceId, userId: user.id };
  }
}
