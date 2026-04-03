import { useEffect } from 'react';
import { AppState } from 'react-native';
import { tallySocket } from '../ws/TallySocket';
import { useAuthStore } from '../stores/authStore';
import { useStatusStore } from '../stores/statusStore';
import { useAlertStore } from '../stores/alertStore';
import { useChatStore } from '../stores/chatStore';
import { useCommandResultStore } from '../stores/commandResultStore';
import type { StatusUpdate, AlertMessage, CommandResult, ChurchConnected, ChurchDisconnected, ChatMessage } from '../ws/types';

/**
 * Manages the TallySocket lifecycle: connects when authenticated,
 * disconnects on logout, reconnects on app foreground, and routes
 * incoming WebSocket messages to the appropriate stores.
 */
export function useTallySocket() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const isLoading = useAuthStore((s) => s.isLoading);

  // Connect/disconnect based on auth state
  useEffect(() => {
    if (isLoading) return;

    if (isLoggedIn) {
      tallySocket.connect();
    } else {
      tallySocket.disconnect();
    }

    return () => {
      // Don't disconnect on unmount — logout handles that
    };
  }, [isLoggedIn, isLoading]);

  // Reconnect when app comes to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && useAuthStore.getState().isLoggedIn) {
        if (!tallySocket.isConnected) {
          tallySocket.connect();
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // Route incoming messages to stores
  useEffect(() => {
    const unsubConnection = tallySocket.onConnection((connected) => {
      useStatusStore.getState().setWsConnected(connected);
    });

    const unsubMessage = tallySocket.onMessage((msg) => {
      switch (msg.type) {
        case 'status_update': {
          const update = msg as StatusUpdate;
          if (update.instanceStatus) {
            useStatusStore.getState().updateInstanceStatus(
              update.instanceStatus,
              update.roomInstanceMap || {},
            );
          }
          break;
        }
        case 'alert': {
          const alert = msg as AlertMessage;
          const { activeRoomId, rooms } = useStatusStore.getState();
          // Only add if alert matches active room or is church-wide (null roomId)
          if (alert.roomId === null || !activeRoomId || alert.roomId === activeRoomId) {
            const roomName = alert.roomId
              ? (rooms.find((r) => r.id === alert.roomId)?.name ?? undefined)
              : undefined;
            useAlertStore.getState().addAlert({
              id: `${alert.timestamp}-${alert.severity}-${Math.random().toString(36).substr(2, 5)}`,
              severity: alert.severity,
              message: alert.message,
              roomId: alert.roomId,
              roomName,
              timestamp: alert.timestamp,
            });
          }
          break;
        }
        case 'command_result': {
          const result = msg as CommandResult;
          useCommandResultStore.getState().addResult(result.messageId, {
            success: !result.error,
            error: result.error || undefined,
            data: result.result,
          });
          break;
        }
        case 'church_connected': {
          const conn = msg as ChurchConnected;
          if (conn.status) {
            useStatusStore.getState().updateInstanceStatus(
              { [conn.instance]: conn.status },
              conn.roomInstanceMap || {},
            );
          }
          break;
        }
        case 'church_disconnected': {
          const disc = msg as ChurchDisconnected;
          useStatusStore.getState().removeInstance(disc.name);
          break;
        }
        case 'chat': {
          const chat = msg as unknown as Record<string, unknown>;
          const roomId = (chat.roomId ?? chat.room_id ?? null) as string | null;
          useChatStore.getState().addMessage({
            id: (chat.id as string) || '',
            churchId: (chat.churchId ?? chat.church_id ?? '') as string,
            senderName: (chat.senderName ?? chat.sender_name ?? '') as string,
            senderRole: (chat.senderRole ?? chat.sender_role ?? 'system') as ChatMessage['senderRole'],
            message: (chat.message as string) || '',
            source: (chat.source as string) || '',
            timestamp: (chat.timestamp as string) || '',
            roomId,
          });
          break;
        }
      }
    });

    return () => {
      unsubConnection();
      unsubMessage();
    };
  }, []);
}
