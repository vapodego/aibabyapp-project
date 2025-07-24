import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import RecordScreen from './screens/RecordScreen';
import ChatScreen from './screens/ChatScreen'; // ←今後分けたいとき
import React, { useEffect } from 'react';
import { loadInitialRecords } from './utils/loadInitialRecords';


const Stack = createNativeStackNavigator();

export default function App() {
  useEffect(() => {
    // アプリ起動時に初期データをロード（AsyncStorageにデータがなければJSONからロード）
    loadInitialRecords();
  }, []);
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Record">
        <Stack.Screen name="Record" component={RecordScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
