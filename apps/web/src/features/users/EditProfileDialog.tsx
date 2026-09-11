'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';
import { updateProfileSchema } from '@sonder/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlay';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { UserAvatar } from '@/components/ui/avatar';
import { useAuthStore } from '@/store/auth';
import { ApiError } from '@/lib/api';

/**
 * Editing the real user record. Avatars are set by URL rather than upload:
 * there is no media pipeline in this build, and a fake upload button would be
 * worse than an honest URL field.
 */
export function EditProfileDialog() {
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const queryClient = useQueryClient();

  const [open, setOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? '');
  const [bio, setBio] = React.useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = React.useState(user?.avatarUrl ?? '');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.displayName);
    setBio(user.bio ?? '');
    setAvatarUrl(user.avatarUrl ?? '');
    setErrors({});
  }, [open, user]);

  if (!user) return null;

  async function handleSave() {
    // Re-read from the store: the component's early return narrows `user` for
    // the render body, but not inside this closure.
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    const payload = {
      displayName: displayName.trim(),
      bio: bio.trim(),
      avatarUrl: avatarUrl.trim() === '' ? null : avatarUrl.trim(),
    };

    const parsed = updateProfileSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setSaving(true);
    try {
      await updateProfile(parsed.data);
      await queryClient.invalidateQueries({ queryKey: ['profile', currentUser.username] });
      toast.success('Profile updated');
      setOpen(false);
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        if (error.fields.length === 0) toast.error(error.message);
      } else {
        toast.error('Could not save your profile.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Pencil aria-hidden />
          Edit profile
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Your username cannot be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4">
          <UserAvatar
            displayName={displayName || user.displayName}
            username={user.username}
            avatarUrl={avatarUrl || null}
            size="xl"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">@{user.username}</p>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>

        <div className="space-y-4">
          <Field label="Name" htmlFor="edit-display-name" error={errors.displayName}>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={50}
              invalid={Boolean(errors.displayName)}
            />
          </Field>

          <Field
            label="Bio"
            htmlFor="edit-bio"
            error={errors.bio}
            hint={`${bio.length}/180`}
          >
            <Textarea
              value={bio}
              onChange={(event) => setBio(event.target.value.slice(0, 180))}
              rows={3}
              invalid={Boolean(errors.bio)}
            />
          </Field>

          <Field
            label="Avatar URL"
            htmlFor="edit-avatar"
            error={errors.avatarUrl}
            hint="Paste an image URL, or leave empty to use your initials."
          >
            <Input
              value={avatarUrl}
              onChange={(event) => setAvatarUrl(event.target.value)}
              placeholder="https://…"
              inputMode="url"
              invalid={Boolean(errors.avatarUrl)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => void handleSave()} loading={saving}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
