import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Pressable,
  KeyboardAvoidingView, Platform, ActivityIndicator, Animated,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';
import { useThemeColors } from '../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [showServer, setShowServer] = useState(false);
  const colors = useThemeColors();

  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);

  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2000, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0, duration: 2000, useNativeDriver: false }),
      ]),
    ).start();
  }, [glowAnim]);

  const glowRadius = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [12, 24],
  });

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.6],
  });

  const handleLogin = async () => {
    const success = await login(email, password, serverUrl || undefined);
    if (success) {
      router.replace('/room-picker');
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xxl }}>
        <View style={{ alignItems: 'center', marginBottom: 48 }}>
          <Animated.View style={{
            width: 80,
            height: 80,
            borderRadius: 20,
            backgroundColor: 'rgba(34, 197, 94, 0.85)',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: spacing.lg,
            shadowColor: colors.accent,
            shadowRadius: glowRadius,
            shadowOpacity: glowOpacity,
          }}>
            <Text style={{ fontSize: 42, fontWeight: '900', color: '#ffffff' }}>T</Text>
          </Animated.View>
          <Text style={{ fontSize: 24, fontWeight: '800', color: colors.text, letterSpacing: 3 }}>TALLY CONNECT</Text>
          <Text style={{ fontSize: fontSize.sm, fontWeight: '400', color: colors.textSecondary, letterSpacing: 1, marginTop: spacing.xs }}>Broadcast Intelligence Platform</Text>
        </View>

        {error ? (
          <View style={{
            backgroundColor: colors.isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(220, 38, 38, 0.08)',
            borderRadius: borderRadius.sm,
            padding: spacing.md,
            marginBottom: spacing.lg,
            borderWidth: 1,
            borderColor: colors.isDark ? 'rgba(239, 68, 68, 0.3)' : 'rgba(220, 38, 38, 0.2)',
          }}>
            <Text style={{ fontSize: fontSize.sm, color: colors.critical }}>{error}</Text>
          </View>
        ) : null}

        <TextInput
          style={{
            backgroundColor: colors.surface,
            borderRadius: borderRadius.md,
            padding: spacing.lg,
            fontSize: fontSize.md,
            color: colors.text,
            marginBottom: spacing.md,
            borderWidth: 1,
            borderColor: colors.border,
          }}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />

        <TextInput
          style={{
            backgroundColor: colors.surface,
            borderRadius: borderRadius.md,
            padding: spacing.lg,
            fontSize: fontSize.md,
            color: colors.text,
            marginBottom: spacing.md,
            borderWidth: 1,
            borderColor: colors.border,
          }}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
        />

        {showServer ? (
          <TextInput
            style={{
              backgroundColor: colors.surface,
              borderRadius: borderRadius.md,
              padding: spacing.lg,
              fontSize: fontSize.md,
              color: colors.text,
              marginBottom: spacing.md,
              borderWidth: 1,
              borderColor: colors.border,
            }}
            placeholder="Server URL (optional)"
            placeholderTextColor={colors.textMuted}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
        ) : (
          <Pressable onPress={() => setShowServer(true)}>
            <Text style={{ fontSize: fontSize.sm, color: colors.accent, marginBottom: spacing.lg, textAlign: 'center' }}>Custom server?</Text>
          </Pressable>
        )}

        <Pressable
          style={[
            {
              backgroundColor: 'rgba(34, 197, 94, 0.85)',
              borderRadius: borderRadius.md,
              padding: spacing.lg,
              alignItems: 'center',
              marginTop: spacing.md,
              shadowColor: colors.accent,
              shadowOpacity: 0.4,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: 6,
            },
            isLoading && { opacity: 0.6 },
          ]}
          onPress={handleLogin}
          disabled={isLoading || !email || !password}
        >
          {isLoading ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={{ fontSize: fontSize.lg, fontWeight: '700', color: '#ffffff' }}>Sign In</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
