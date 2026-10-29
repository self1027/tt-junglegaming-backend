export interface IntegrationEventProps<T> {
	readonly eventId: string;
	readonly aggregateId: string;
	readonly correlationId: string;
	readonly causationId?: string;
	readonly occurredAt: Date;
	readonly data: T;
}

export function eventText(value: string): string {
	if (
		typeof value !== 'string' ||
		value.trim().length === 0 ||
		value.includes('\0') ||
		/[\uD800-\uDFFF]/u.test(value)
	)
		throw new Error('Invalid event text');
	return value;
}

export function eventUuid(value: string): string {
	if (
		typeof value !== 'string' ||
		!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
			value,
		)
	)
		throw new Error('Invalid event UUID');
	return value.toLowerCase();
}

export abstract class IntegrationEvent<T, Type extends string> {
	abstract readonly eventType: Type;
	abstract readonly version: 1;
	readonly eventId: string;
	readonly aggregateId: string;
	readonly correlationId: string;
	readonly causationId?: string;
	readonly data: Readonly<T>;
	readonly #occurredAt: number;

	protected constructor(props: IntegrationEventProps<T>) {
		this.eventId = eventUuid(props.eventId);
		this.aggregateId = eventUuid(props.aggregateId);
		this.correlationId = eventText(props.correlationId);
		if (props.causationId !== undefined)
			this.causationId = eventText(props.causationId);
		if (
			!(props.occurredAt instanceof Date) ||
			!Number.isFinite(props.occurredAt.getTime())
		)
			throw new Error('Invalid event occurrence');
		this.#occurredAt = props.occurredAt.getTime();
		this.data = Object.freeze(props.data);
	}

	get occurredAt(): Date {
		return new Date(this.#occurredAt);
	}

	toJSON(): {
		eventId: string;
		eventType: Type;
		aggregateId: string;
		correlationId: string;
		causationId?: string;
		occurredAt: string;
		version: 1;
		data: Readonly<T>;
	} {
		return {
			eventId: this.eventId,
			eventType: this.eventType,
			aggregateId: this.aggregateId,
			correlationId: this.correlationId,
			...(this.causationId === undefined
				? {}
				: { causationId: this.causationId }),
			occurredAt: this.occurredAt.toISOString(),
			version: this.version,
			data: this.data,
		};
	}
}
