import { HubError } from './contracts.js';

// Reviewed presets, not an account entitlement check. Keep provider catalogs separate.
export const modelOptions = {
  reviewedOn: '2026-10-25',
  providers: [
    {
      id: 'claude', label: 'Claude Code', source: 'https://code.claude.com/docs/en/model-config',
      models: [
        { id: 'default', label: 'Use client default', description: 'Keep the model and effort configured in your Claude session.', efforts: ['default'] },
        { id: 'sonnet', label: 'Sonnet — everyday coding', description: 'Claude Code alias for the latest Sonnet; a practical choice for routine coding.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'opus', label: 'Opus — complex reasoning', description: 'Claude Code alias for the latest Opus; consider it for difficult analysis and reviews.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'haiku', label: 'Haiku — quick, focused tasks', description: 'Claude Code alias for the latest Haiku; suited to smaller, well-scoped tasks.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'fable', label: 'Fable — demanding, long tasks', description: 'Availability and usage-credit requirements depend on your account and provider.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] }
      ]
    },
    {
      id: 'codex', label: 'Codex', source: 'https://learn.chatgpt.com/docs/models',
      models: [
        { id: 'default', label: 'Use client default', description: 'Keep the model and effort configured in your Codex session.', efforts: ['default'] },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol — general coding', description: 'A workhorse for coding and repeated workflows; available according to your account and client.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-6-astra', label: 'GPT-6 Astra — demanding work', description: 'For complex tasks needing sustained reasoning and judgment.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-6-luna', label: 'GPT-6 Luna — focused tasks', description: 'An efficient choice for clear, repeatable tasks. Supports up to Max, not Ultra.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'gpt-6-sol', label: 'GPT-6 Sol — previous generation', description: 'Previous-generation workhorse; keep it when it fits your existing workflow.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — older workhorse', description: 'Older model option; confirm availability in your client.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — older balanced', description: 'Older balanced model for straightforward tasks; confirm availability in your client.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — older fast model', description: 'Older efficient model. Supports up to Max, not Ultra.', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] }
      ]
    }
  ],
  efforts: {
    default: { label: 'Client default (recommended)', description: 'Keep the host’s existing effort setting; no override.' },
    low: { label: 'Low — faster', description: 'Lighter reasoning for quick, well-scoped tasks.' },
    medium: { label: 'Medium — balanced', description: 'Balances response time and reasoning depth.' },
    high: { label: 'High — deeper reasoning', description: 'More reasoning for difficult work; can take longer and use more tokens.' },
    xhigh: { label: 'Extra high — complex work', description: 'Additional reasoning for complex tasks, with greater time and usage.' },
    max: { label: 'Max — hardest tasks', description: 'Maximum reasoning depth for a single task. Expect greater time and token usage.' },
    ultra: { label: 'Ultra — may use subagents', description: 'Supported Codex clients may delegate work to subagents. Requires suitable account access and explicit task authorization.' }
  }
};

export function validateModelPreference(providerId: string, modelId: string, effort?: string): void {
  if (effort === undefined) return; // Preserve existing generic API/CLI registrations.
  const provider = modelOptions.providers.find(item => item.id === providerId);
  if (!provider) throw new HubError(400, 'Model preferences require Claude Code or Codex');
  const model = provider.models.find(item => item.id === modelId);
  if (!model && effort !== 'default') throw new HubError(400, 'Custom models must use client-default effort; configure supported levels in the host');
  if (model && !model.efforts.includes(effort)) throw new HubError(400, 'This model preset does not support the selected effort');
}
