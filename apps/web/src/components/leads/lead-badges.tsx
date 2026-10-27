import {
  Briefcase,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  Globe,
  HeartHandshake,
  Megaphone,
  MessageSquareDot,
  Phone,
  Sparkles,
  Star,
  Target,
  Trophy,
  Users,
  XCircle,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { LeadSource, LeadStage } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';

type Tone = Parameters<typeof Badge>[0]['tone'];

const STAGE_META: Record<
  LeadStage,
  { label: string; icon: ComponentType<{ className?: string }>; tone: Tone }
> = {
  NEW: { label: 'New', icon: Sparkles, tone: 'neutral' },
  QUALIFIED: { label: 'Qualified', icon: Star, tone: 'info' },
  CONTACTED: { label: 'Contacted', icon: MessageSquareDot, tone: 'info' },
  DEMO_SCHEDULED: { label: 'Demo Scheduled', icon: CalendarClock, tone: 'brand' },
  DEMO_COMPLETED: { label: 'Demo Completed', icon: CalendarCheck2, tone: 'success' },
  PROPOSAL: { label: 'Proposal', icon: Briefcase, tone: 'brand' },
  NEGOTIATION: { label: 'Negotiation', icon: HeartHandshake, tone: 'warning' },
  WON: { label: 'Won', icon: Trophy, tone: 'success' },
  LOST: { label: 'Lost', icon: XCircle, tone: 'danger' },
};

const SOURCE_META: Record<
  LeadSource,
  { label: string; icon: ComponentType<{ className?: string }>; tone: Tone }
> = {
  WEBSITE: { label: 'Website', icon: Globe, tone: 'info' },
  REFERRAL: { label: 'Referral', icon: Users, tone: 'success' },
  COLD_OUTREACH: { label: 'Cold outreach', icon: Phone, tone: 'neutral' },
  EVENT: { label: 'Event', icon: Megaphone, tone: 'brand' },
  SOCIAL: { label: 'Social', icon: CheckCircle2, tone: 'info' },
  PARTNER: { label: 'Partner', icon: Target, tone: 'warning' },
  OTHER: { label: 'Other', icon: Star, tone: 'neutral' },
};

export function StageBadge({ stage }: { stage: LeadStage }) {
  const meta = STAGE_META[stage];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} aria-label={`Stage: ${meta.label}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: LeadSource }) {
  const meta = SOURCE_META[source];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} aria-label={`Source: ${meta.label}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

export const STAGE_OPTIONS: readonly LeadStage[] = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

export const SOURCE_OPTIONS: readonly LeadSource[] = [
  'WEBSITE',
  'REFERRAL',
  'COLD_OUTREACH',
  'EVENT',
  'SOCIAL',
  'PARTNER',
  'OTHER',
];

export const stageLabel = (s: LeadStage) => STAGE_META[s].label;
export const sourceLabel = (s: LeadSource) => SOURCE_META[s].label;
