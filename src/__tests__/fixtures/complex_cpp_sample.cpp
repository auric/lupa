/**
 * @file complex_cpp_sample.cpp
 * @brief A complex C++ sample with various structures to test code chunking
 * @author Test Team
 * @copyright 2025 Test Company
 */

#include <iostream>
#include <vector>
#include <string>
#include <map>
#include <algorithm>
#include <memory>
#include <functional>

// Global constants
const int MAX_ITEMS = 100;
const double PI = 3.14159265358979;

/**
 * A namespace containing utility functions and classes
 */
namespace utils {
    
    // Forward declarations
    class Helper;
    template<typename T> class Container;
    
    /**
     * A simple enumeration for status codes
     */
    enum class StatusCode {
        OK = 0,
        WARNING = 1,
        ERROR = 2,
        CRITICAL = 3
    };
    
    /**
     * A simple class for demonstration
     */
    class Helper {
    public:
        // Constructors and destructor
        Helper() = default;
        explicit Helper(int value) : mValue(value) {}
        ~Helper() = default;
        
        /**
         * Performs a calculation
         * @param value The input value
         * @return The calculated result
         */
        int calculate(int value) {
            // This is a simple calculation
            return value * mValue;
        }
        
        /**
         * Formats a string
         * @param input The input string
         * @return The formatted string
         */
        std::string format(const std::string& input) {
            return "[" + input + "]";
        }
        
        // Getters and setters
        int getValue() const { return mValue; }
        void setValue(int value) { mValue = value; }
        
    private:
        int mValue = 1; // Default value
    };
    
    /**
     * A template container class
     */
    template<typename T>
    class Container {
    public:
        // Type definitions
        using value_type = T;
        using reference = T&;
        using const_reference = const T&;
        
        // Constructors
        Container() = default;
        explicit Container(size_t size) : mItems(size) {}
        
        // Element access
        reference at(size_t index) { return mItems.at(index); }
        const_reference at(size_t index) const { return mItems.at(index); }
        
        // Capacity
        size_t size() const { return mItems.size(); }
        bool empty() const { return mItems.empty(); }
        
        // Modifiers
        void push_back(const T& value) { mItems.push_back(value); }
        void pop_back() { mItems.pop_back(); }
        
        // Iterators
        auto begin() { return mItems.begin(); }
        auto end() { return mItems.end(); }
        
    private:
        std::vector<T> mItems; // Storage for items
    };
    
    /**
     * A utility function to process data
     * @param data The data to process
     * @return The processed data
     */
    template<typename T>
    std::vector<T> processData(const std::vector<T>& data) {
        std::vector<T> result;
        
        // Reserve space for efficiency
        result.reserve(data.size());
        
        for (const auto& item : data) {
            // Skip negative values for numeric types
            if constexpr (std::is_arithmetic_v<T>) {
                if (item < 0) continue;
            }
            
            // Process positive values
            result.push_back(item * 2);
        }
        
        return result;
    }
    
    // Namespace for string utilities
    namespace strings {
        /**
         * Joins a vector of strings with a delimiter
         * @param strings The strings to join
         * @param delimiter The delimiter to use
         * @return The joined string
         */
        std::string join(const std::vector<std::string>& strings, const std::string& delimiter) {
            std::string result;
            
            for (size_t i = 0; i < strings.size(); ++i) {
                result += strings[i];
                if (i < strings.size() - 1) {
                    result += delimiter;
                }
            }
            
            return result;
        }
        
        /**
         * Splits a string by a delimiter
         * @param input The input string
         * @param delimiter The delimiter to split by
         * @return A vector of split strings
         */
        std::vector<std::string> split(const std::string& input, const std::string& delimiter) {
            std::vector<std::string> result;
            size_t start = 0;
            size_t end = input.find(delimiter);
            
            while (end != std::string::npos) {
                result.push_back(input.substr(start, end - start));
                start = end + delimiter.length();
                end = input.find(delimiter, start);
            }
            
            result.push_back(input.substr(start));
            return result;
        }
    } // namespace strings
} // namespace utils

/**
 * The main application class
 */
class Application {
private:
    // Member variables
    utils::Helper helper;
    std::vector<int> data;
    std::map<std::string, std::function<void()>> commands;
    
public:
    /**
     * Constructor
     */
    Application() {
        // Initialize with some data
        data = {1, 2, 3, 4, 5};
        
        // Register commands
        commands["help"] = [this]() { showHelp(); };
        commands["run"] = [this]() { run(); };
        commands["exit"] = []() { std::cout << "Exiting..." << std::endl; };
    }
    
    /**
     * Shows help information
     */
    void showHelp() {
        std::cout << "Available commands:" << std::endl;
        for (const auto& [name, _] : commands) {
            std::cout << "- " << name << std::endl;
        }
    }
    
    /**
     * Run the application
     */
    void run() {
        // Process the data
        auto processedData = utils::processData(data);
        
        // Print the results
        for (const auto& item : processedData) {
            std::cout << "Item: " << item << std::endl;
            
            // Calculate and print
            int calculated = helper.calculate(item);
            std::cout << "Calculated: " << calculated << std::endl;
            
            // Format and print
            std::string formatted = helper.format(std::to_string(calculated));
            std::cout << "Formatted: " << formatted << std::endl;
        }
    }
    
    /**
     * Execute a command
     * @param name The command name
     * @return True if the command was found and executed
     */
    bool executeCommand(const std::string& name) {
        auto it = commands.find(name);
        if (it != commands.end()) {
            it->second();
            return true;
        }
        return false;
    }
};

/**
 * A complex struct with nested types
 */
struct ComplexData {
    // Nested enum
    enum Type {
        TYPE_A,
        TYPE_B,
        TYPE_C
    };
    
    // Nested struct
    struct Entry {
        std::string name;
        int value;
        
        // Operator overloading
        bool operator<(const Entry& other) const {
            return value < other.value;
        }
    };
    
    // Member variables
    Type type;
    std::vector<Entry> entries;
    
    // Member functions
    void addEntry(const std::string& name, int value) {
        entries.push_back({name, value});
    }
    
    void sortEntries() {
        std::sort(entries.begin(), entries.end());
    }
};

/**
 * Main entry point
 */
int main() {
    // Create and run the application
    Application app;
    
    // Show help
    app.showHelp();
    
    // Run the application
    app.run();
    
    // Create a complex data structure
    ComplexData data;
    data.type = ComplexData::TYPE_B;
    data.addEntry("First", 42);
    data.addEntry("Second", 23);
    data.addEntry("Third", 73);
    
    // Sort the entries
    data.sortEntries();
    
    // Use the utils::strings namespace
    std::vector<std::string> words = {"Hello", "World", "C++"};
    std::string joined = utils::strings::join(words, ", ");
    std::cout << "Joined: " << joined << std::endl;
    
    std::vector<std::string> split = utils::strings::split(joined, ", ");
    std::cout << "Split size: " << split.size() << std::endl;
    
    return 0;
}
