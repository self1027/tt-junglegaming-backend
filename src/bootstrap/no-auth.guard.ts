import type { CanActivate } from '@nestjs/common';

/** Authentication is deliberately omitted; replace this extension with external IdP integration. */
export class NoAuthGuard implements CanActivate {
	canActivate(): boolean {
		return true;
	}
}
