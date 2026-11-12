import { BadRequestException } from "@nestjs/common";
import { WalletLedgerEntryEntity } from "../../database/entities/wallet-ledger-entry.entity.js";

export function encodeCursor(entry: WalletLedgerEntryEntity): string {
    return Buffer.from(
        JSON.stringify({
            createdAt: entry.createdAt.toISOString(),
            id: entry.id,
        }),
    ).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
    try {
        const value = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        ) as {
            createdAt: string;
            id: string;
        };
        const createdAt = new Date(value.createdAt);
        if (
            !Number.isFinite(createdAt.getTime()) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                value.id,
            )
        ) {
            throw new Error('Invalid ledger cursor');
        }
        return { createdAt, id: value.id };
    } catch {
        throw new BadRequestException({
            code: 'INVALID_CURSOR',
            message: 'The ledger cursor is invalid',
        });
    }
}