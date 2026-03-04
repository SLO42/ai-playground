<script lang="ts">
	type AlertVariant = 'critical' | 'warning' | 'info';

	interface Props {
		variant?: AlertVariant;
		message: string;
		dismissible?: boolean;
		onDismiss?: () => void;
	}

	let { variant = 'info', message, dismissible = true, onDismiss }: Props = $props();

	let visible = $state(true);

	const styles: Record<AlertVariant, { bg: string; border: string; text: string; icon: string }> = {
		critical: {
			bg: 'bg-accent-red/10',
			border: 'border-accent-red/30',
			text: 'text-accent-red',
			icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z'
		},
		warning: {
			bg: 'bg-accent-yellow/10',
			border: 'border-accent-yellow/30',
			text: 'text-accent-yellow',
			icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z'
		},
		info: {
			bg: 'bg-accent-blue/10',
			border: 'border-accent-blue/30',
			text: 'text-accent-blue',
			icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
		}
	};

	function dismiss() {
		visible = false;
		onDismiss?.();
	}
</script>

{#if visible}
	<div class="w-full {styles[variant].bg} border {styles[variant].border} rounded-lg px-4 py-3 flex items-center gap-3">
		<svg class="w-5 h-5 {styles[variant].text} flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
			<path stroke-linecap="round" stroke-linejoin="round" d={styles[variant].icon} />
		</svg>
		<span class="text-sm text-text-primary flex-1">{message}</span>
		{#if dismissible}
			<button
				onclick={dismiss}
				class="text-text-secondary hover:text-text-primary transition-colors text-lg leading-none flex-shrink-0"
			>
				&times;
			</button>
		{/if}
	</div>
{/if}
