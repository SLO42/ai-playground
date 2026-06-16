// server/atelier — G-C: the atelier-wide timeline read + the §5b inbox/comms lens
// (GLOBAL-TRANSCRIPT-SPEC).
export {
	readAtelierTimeline,
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	DEFAULT_WINDOW_MS,
	type TimelineScope,
	type TimelineSource,
	type TimelineEntry,
	type TimelinePage,
	type TimelineQuery
} from './timeline';

// §5b — the inbox / comms lens over the fleet's peer_message bus.
export {
	readInbox,
	isInboxStatus,
	INBOX_STATUSES,
	DEFAULT_INBOX_PAGE_SIZE,
	MAX_INBOX_PAGE_SIZE,
	DEFAULT_INBOX_WINDOW_MS,
	type InboxItem,
	type InboxPage,
	type InboxQuery
} from './inbox';
