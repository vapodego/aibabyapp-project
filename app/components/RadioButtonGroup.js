import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

const RadioButtonGroup = ({ label, options, selectedValue, onValueChange }) => (
    <View>
        <Text style={styles.inputLabel}>{label}</Text>
        <View style={styles.radioContainer}>
            {options.map(option => (
                <TouchableOpacity key={option} style={styles.radioOption} onPress={() => onValueChange(option)}>
                    <View style={styles.radioOuter}>
                        {selectedValue === option && <View style={styles.radioInner} />}
                    </View>
                    <Text>{option}</Text>
                </TouchableOpacity>
            ))}
        </View>
    </View>
);

const styles = StyleSheet.create({
    inputLabel: { fontSize: 16, color: '#333', marginBottom: 8, marginTop: 8, fontWeight: 'bold' },
    radioContainer: { flexDirection: 'row', marginBottom: 12, flexWrap: 'wrap' },
    radioOption: { flexDirection: 'row', alignItems: 'center', marginRight: 15, paddingVertical: 5 },
    radioOuter: { height: 20, width: 20, borderRadius: 10, borderWidth: 2, borderColor: '#6C63FF', alignItems: 'center', justifyContent: 'center', marginRight: 5 },
    radioInner: { height: 10, width: 10, borderRadius: 5, backgroundColor: '#6C63FF' },
});

export default RadioButtonGroup;
