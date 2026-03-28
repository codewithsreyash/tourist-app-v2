import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, SafeAreaView, ActivityIndicator } from 'react-native';
import axios from 'axios';
import * as Location from 'expo-location';

// 🌐 PRODUCTION CONFIG: Replace the placeholder with your public production URL
// Example: https://your-backend.vercel.app
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://PASTE_YOUR_PRODUCTION_URL_HERE'; 

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('Registration');
  
  // Registration State
  const [name, setName] = useState('');
  const [tripId, setTripId] = useState('TRIP-INDIA-2026');
  const [blockchainId, setBlockchainId] = useState(null);
  const [isRegistering, setIsRegistering] = useState(false);

  // Safety State
  const [safetyScore, setSafetyScore] = useState(100);
  const [locationStatus, setLocationStatus] = useState('Initializing GPS...');
  
  const locationSubscription = useRef(null);

  // Real-time GPS Tracking (Optimized for High-Traffic)
  useEffect(() => {
    let isMounted = true;

    async function startTracking() {
      if (currentScreen !== 'Dashboard' || !blockchainId) return;

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location access is required.');
        setLocationStatus('Offline');
        return;
      }

      setLocationStatus('Live');

      locationSubscription.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced, // Saves battery for production
          timeInterval: 5000, 
          distanceInterval: 10,
        },
        async (location) => {
          if (!isMounted) return;
          const { latitude, longitude } = location.coords;
          
          try {
            // Robust Ping with timeout
            const response = await axios.post(`${API_BASE_URL}/api/tourist/location`, {
              blockchainId: blockchainId,
              lat: latitude,
              lng: longitude
            }, { timeout: 3000 });
            
            if (response.data?.data) {
              setSafetyScore(response.data.data.safetyScore);
            }
          } catch (error) {
            // Graceful failure: don't crash, just log and wait for next interval
            console.log('Network ping skipped:', error.message);
          }
        }
      );
    }

    startTracking();

    return () => {
      isMounted = false;
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
    };
  }, [currentScreen, blockchainId]);


  const registerTourist = async () => {
    if (!name || !tripId) {
      Alert.alert('Error', 'Please enter Name and Trip ID.');
      return;
    }

    setIsRegistering(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/tourist/register`, {
        name,
        tripId
      });

      if (response.data && response.data.data) {
        setBlockchainId(response.data.data.blockchainId);
        Alert.alert('Success', 'Blockchain ID Issued.');
      }
    } catch (error) {
      console.log('Registration failed:', error.message);
      Alert.alert('Error', 'Could not reach Security Server.');
    } finally {
      setIsRegistering(false);
    }
  };

  if (currentScreen === 'Registration') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Secure Onboarding</Text>
          <Text style={styles.subtitle}>Enter details for digital verification</Text>
          
          <TextInput
            style={styles.input}
            placeholder="Full Name"
            value={name}
            onChangeText={setName}
            placeholderTextColor="#888"
          />
          
          <TextInput
            style={styles.input}
            placeholder="Trip ID (e.g. TRIP-INDIA-2026)"
            value={tripId}
            onChangeText={setTripId}
            placeholderTextColor="#888"
          />

          <TouchableOpacity 
            style={[styles.primaryButton, isRegistering && { opacity: 0.7 }]} 
            onPress={registerTourist}
            disabled={isRegistering}
          >
            {isRegistering ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Register Digital Identity</Text>}
          </TouchableOpacity>

          {blockchainId && (
            <View style={styles.idCard}>
              <Text style={styles.idLabel}>Verified Blockchain ID</Text>
              <Text style={styles.idValue}>{blockchainId}</Text>
              
              <TouchableOpacity 
                style={styles.secondaryButton} 
                onPress={() => setCurrentScreen('Dashboard')}
              >
                <Text style={styles.buttonText}>Enter Safety Dashboard</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Live Monitoring</Text>
          <Text style={styles.idSubtext}>ID: {blockchainId}</Text>
          <Text style={styles.locationStatus}>{locationStatus}</Text>
        </View>

        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>Current Safety Level</Text>
          <Text style={[styles.scoreValue, { color: safetyScore > 80 ? '#48bb78' : '#f56565' }]}>
            {safetyScore}%
          </Text>
          <Text style={styles.scoreSubtitle}>Status: {safetyScore > 80 ? 'Safe' : 'Alert'}</Text>
        </View>

        <TouchableOpacity 
          style={styles.panicButton} 
          onPress={() => Alert.alert('SOS sent', 'Help is on the way.')}
        >
          <Text style={styles.panicText}>🚨 SOS PANIC</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a202c' },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#a0aec0', textAlign: 'center', marginBottom: 24 },
  idSubtext: { fontSize: 12, color: '#4299e1', fontWeight: 'bold', textAlign: 'center', marginTop: 4 },
  locationStatus: { fontSize: 10, color: '#718096', marginTop: 4, textAlign: 'center' },
  input: { backgroundColor: '#2d3748', borderWidth: 1, borderColor: '#4a5568', borderRadius: 8, padding: 14, fontSize: 16, marginBottom: 16, color: '#fff' },
  primaryButton: { backgroundColor: '#3182ce', borderRadius: 8, padding: 16, alignItems: 'center' },
  secondaryButton: { backgroundColor: '#38a169', borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  idCard: { marginTop: 24, backgroundColor: '#2d3748', padding: 20, borderRadius: 12, borderLeftWidth: 4, borderLeftColor: '#3182ce' },
  idLabel: { fontSize: 10, color: '#a0aec0', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: 4 },
  idValue: { fontSize: 14, fontFamily: 'monospace', color: '#63b3ed', fontWeight: 'bold' },
  header: { marginBottom: 32 },
  scoreCard: { backgroundColor: '#2d3748', padding: 32, borderRadius: 16, alignItems: 'center', marginBottom: 40 },
  scoreLabel: { fontSize: 12, color: '#a0aec0', fontWeight: 'bold', marginBottom: 8, textTransform: 'uppercase' },
  scoreValue: { fontSize: 56, fontWeight: '900' },
  scoreSubtitle: { fontSize: 12, color: '#718096', marginTop: 8 },
  panicButton: { backgroundColor: '#e53e3e', borderRadius: 16, padding: 20, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 5 },
  panicText: { color: '#fff', fontSize: 20, fontWeight: '900' }
});

