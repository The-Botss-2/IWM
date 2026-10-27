'use client';

import { CheckCircle2 } from 'lucide-react';
import { CHAT_REQUEST_MESSAGE_MAX } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useChatRequestForm } from '@/hooks/use-chat-requests';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Ask someone at another company to chat. The reply is the same notice for
 * every address, so the dialog never says whether the person exists.
 */
export function ChatRequestDialog({ open, onOpenChange }: Props) {
  const form = useChatRequestForm();

  function handleOpenChange(next: boolean): void {
    if (!next) form.reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a chat request</DialogTitle>
          <DialogDescription>
            Reach someone at another company by their work email. If they
            accept, a direct chat opens for both of you.
          </DialogDescription>
        </DialogHeader>

        {form.notice ? (
          <div className="flex items-start gap-3 rounded-md border border-line bg-bg-subtle px-3 py-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">{form.notice}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                You can see and cancel sent requests in Settings, Communication.
              </p>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              form.submit();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="chat-request-email">Work email</Label>
              <Input
                id="chat-request-email"
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(e) => form.setEmail(e.target.value)}
                placeholder="name@company.com"
                maxLength={254}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="chat-request-message">Message</Label>
                <span
                  className={
                    form.tooLong ? 'text-[11px] text-state-error' : 'text-[11px] text-ink-muted'
                  }
                >
                  {form.message.length}/{CHAT_REQUEST_MESSAGE_MAX}
                </span>
              </div>
              <Textarea
                id="chat-request-message"
                value={form.message}
                onChange={(e) => form.setMessage(e.target.value)}
                placeholder="Say who you are and why you'd like to chat."
                rows={4}
                maxLength={CHAT_REQUEST_MESSAGE_MAX}
              />
            </div>
          </form>
        )}

        <DialogFooter>
          {form.notice ? (
            <>
              <Button variant="secondary" onClick={form.reset}>
                Send another
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => handleOpenChange(false)}
                disabled={form.pending}
              >
                Cancel
              </Button>
              <Button onClick={form.submit} disabled={!form.canSend || form.pending}>
                {form.pending ? 'Sending…' : 'Send request'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
