import { Router } from "express";
import registerOidcRoutes from "./oidc";
import registerAppPasswordRoutes from "./appPasswords";
import registerLinkedIdentityRoutes from "./linkedIdentities";
import registerLocalCredentialRoutes from "./localCredentials";
import {
    registerAccountProfileRoutes,
    registerSecondFactorAndSubsonicRoutes,
} from "./accountSecurity";
import registerAdminUserInviteRoutes from "./adminUserInvites";

const router = Router();

registerOidcRoutes(router);
registerAppPasswordRoutes(router);
registerLinkedIdentityRoutes(router);
registerLocalCredentialRoutes(router);
registerAccountProfileRoutes(router);
registerAdminUserInviteRoutes(router);
registerSecondFactorAndSubsonicRoutes(router);

export default router;
