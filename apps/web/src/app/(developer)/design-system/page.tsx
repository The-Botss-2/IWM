'use client';

import { Check, Loader2, Search, Star, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Logo } from '@/components/branding/logo';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';

interface SectionDef {
  id: string;
  title: string;
  Render: () => ReactNode;
}

/**
 * Internal-only catalogue of every shared UI primitive in
 * `apps/web/src/components/ui/`. Add a new entry to `SECTIONS` whenever a new
 * component lands so future developers can compare variants side-by-side.
 *
 * This page is mounted under the `(developer)` route group, which 404s in
 * production. No real session is required - the catalog is purely visual.
 */
export default function DesignSystemPage() {
  // SECTIONS is a non-empty literal; the non-null assertion keeps the strict
  // `noUncheckedIndexedAccess` setting happy without runtime guards.
  const first = SECTIONS[0]!;
  const [active, setActive] = useState(first.id);
  const activeSection = SECTIONS.find((s) => s.id === active) ?? first;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-8 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <Link href="/" aria-label="Back to app" className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus">
          <Logo variant="full" size="sm" />
        </Link>
        <div className="text-xs text-ink-muted">Dev only · /design-system</div>
      </header>

      <h1 className="mb-1 text-2xl font-semibold text-ink">Design system</h1>
      <p className="mb-6 text-sm text-ink-muted">
        Live catalogue of every shared UI primitive shipped in <code>apps/web</code>. Click an
        entry on the left to focus a single component.
      </p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        <nav className="space-y-1 text-sm md:sticky md:top-4 md:self-start">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              className={`block w-full rounded px-3 py-1.5 text-left transition-colors ${
                active === s.id
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-ink-muted hover:bg-bg-subtle hover:text-ink'
              }`}
            >
              {s.title}
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          <section
            key={activeSection.id}
            className="rounded-md border border-line bg-white p-6"
            aria-labelledby={`section-${activeSection.id}`}
          >
            <h2 id={`section-${activeSection.id}`} className="mb-4 text-lg font-semibold text-ink">
              {activeSection.title}
            </h2>
            {activeSection.Render()}
          </section>
        </div>
      </div>
    </main>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

const SECTIONS: SectionDef[] = [
  {
    id: 'button',
    title: 'Button',
    Render: () => (
      <div className="space-y-5">
        <Field label="Variants">
          <Row>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="destructive">Destructive</Button>
          </Row>
        </Field>
        <Field label="Sizes">
          <Row>
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Search"><Search className="h-4 w-4" /></Button>
          </Row>
        </Field>
        <Field label="Loading / Disabled">
          <Row>
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </Button>
            <Button disabled variant="secondary">Disabled</Button>
            <Button variant="primary"><Star className="h-4 w-4" /> With icon</Button>
          </Row>
        </Field>
      </div>
    ),
  },
  {
    id: 'input',
    title: 'Input / Textarea / Password',
    Render: () => (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Text input">
          <Input placeholder="Type here…" />
        </Field>
        <Field label="With label">
          <Label htmlFor="ds-input">Email</Label>
          <Input id="ds-input" type="email" placeholder="you@example.com" />
        </Field>
        <Field label="Textarea">
          <Textarea rows={3} placeholder="Multiline…" />
        </Field>
        <Field label="Password">
          <PasswordInput placeholder="Hidden by default" />
        </Field>
      </div>
    ),
  },
  {
    id: 'select',
    title: 'Select',
    Render: () => {
      const [value, setValue] = useState('a');
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Single select">
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="a">Alpha</SelectItem>
                <SelectItem value="b">Beta</SelectItem>
                <SelectItem value="c">Gamma</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      );
    },
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    Render: () => {
      const [checked, setChecked] = useState(true);
      return (
        <div className="space-y-3">
          <Row>
            <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
            <span className="text-sm">Controlled checkbox</span>
          </Row>
          <Row>
            <Checkbox disabled />
            <span className="text-sm text-ink-muted">Disabled</span>
          </Row>
        </div>
      );
    },
  },
  {
    id: 'badge',
    title: 'Badge',
    Render: () => (
      <Row>
        <Badge tone="neutral">Neutral</Badge>
        <Badge tone="info">Info</Badge>
        <Badge tone="success">Success</Badge>
        <Badge tone="warning">Warning</Badge>
        <Badge tone="danger">Danger</Badge>
        <Badge tone="brand">Brand</Badge>
      </Row>
    ),
  },
  {
    id: 'avatar',
    title: 'Avatar',
    Render: () => (
      <Row>
        <UserAvatar size="sm" name="Alex" image={null} />
        <UserAvatar size="md" name="Sam Lee" image={null} />
        <UserAvatar size="lg" name="Botss Team" image={null} />
      </Row>
    ),
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    Render: () => (
      <Row>
        <Tooltip content="Helpful detail on hover">
          <Button variant="secondary">Hover me</Button>
        </Tooltip>
      </Row>
    ),
  },
  {
    id: 'popover',
    title: 'Popover',
    Render: () => (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="secondary">Open popover</Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <div className="space-y-1">
            <div className="text-sm font-medium">Popover content</div>
            <p className="text-xs text-ink-muted">Anchored to the trigger with arrow-key + ESC support.</p>
          </div>
        </PopoverContent>
      </Popover>
    ),
  },
  {
    id: 'dialog',
    title: 'Dialog',
    Render: () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Example dialog</DialogTitle>
                <DialogDescription>Focus is trapped here. ESC closes.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <p className="text-sm">Use this for confirmations, short forms, and disambiguation.</p>
                <Row>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={() => setOpen(false)}>Confirm</Button>
                </Row>
              </div>
            </DialogContent>
          </Dialog>
        </>
      );
    },
  },
  {
    id: 'sheet',
    title: 'Sheet (drawer)',
    Render: () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open sheet</Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Example sheet</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <p className="text-sm text-ink-muted">
                  Used for the task detail panel and other side-mounted forms.
                </p>
              </SheetBody>
            </SheetContent>
          </Sheet>
        </>
      );
    },
  },
  {
    id: 'tabs',
    title: 'Tabs',
    Render: () => (
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">First</TabsTrigger>
          <TabsTrigger value="b">Second</TabsTrigger>
          <TabsTrigger value="c">Third</TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="mt-3 text-sm text-ink-muted">
          First panel content.
        </TabsContent>
        <TabsContent value="b" className="mt-3 text-sm text-ink-muted">
          Second panel content.
        </TabsContent>
        <TabsContent value="c" className="mt-3 text-sm text-ink-muted">
          Third panel content.
        </TabsContent>
      </Tabs>
    ),
  },
  {
    id: 'skeleton',
    title: 'Skeleton',
    Render: () => (
      <div className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    ),
  },
  {
    id: 'logo',
    title: 'Logo',
    Render: () => (
      <div className="space-y-4">
        <Field label="Full lockup">
          <div className="rounded-md border border-line bg-white px-4 py-3">
            <Logo variant="full" size="lg" />
          </div>
        </Field>
        <Field label="Icon only">
          <div className="rounded-md border border-line bg-white px-4 py-3">
            <Logo variant="icon" size="lg" />
          </div>
        </Field>
        <Field label="Inverse on dark surface">
          <div className="rounded-md bg-ink px-4 py-3">
            <Logo variant="full" size="md" inverse />
          </div>
        </Field>
      </div>
    ),
  },
  {
    id: 'icons',
    title: 'Icon sizing reference',
    Render: () => (
      <Row>
        <span className="inline-flex items-center gap-1 text-xs"><Check className="h-3 w-3" /> 12px</span>
        <span className="inline-flex items-center gap-1 text-xs"><Check className="h-3.5 w-3.5" /> 14px</span>
        <span className="inline-flex items-center gap-1 text-sm"><Check className="h-4 w-4" /> 16px (default)</span>
        <span className="inline-flex items-center gap-1 text-sm"><X className="h-5 w-5" /> 20px</span>
      </Row>
    ),
  },
];
